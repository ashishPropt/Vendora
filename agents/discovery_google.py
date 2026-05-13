"""
agents/discovery_google.py  —  Agent 2: Google Places Discovery Agent

Queries the Google Places API (New) Text Search endpoint for vendors by
category x geographic tile (ZIP centroid-based).
"""

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx
import redis.asyncio as aioredis
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type

from config import settings
from taxonomy import TAXONOMY_LEAF_NODES
from utils import AsyncRedisTokenBucket, CircuitBreaker

logger = logging.getLogger(__name__)

GOOGLE_PLACES_API_BASE = "https://places.googleapis.com/v1/places:searchText"
STREAM_KEY = "vendors:raw:google"

FIELDS_MASK = (
    "places.id,places.displayName,places.formattedAddress,"
    "places.nationalPhoneNumber,places.websiteUri,places.rating,"
    "places.userRatingCount,places.businessStatus,"
    "places.currentOpeningHours,places.primaryType,places.types,"
    "places.location,places.plusCode"
)

TIER_1_STATES = {
    "CA", "TX", "FL", "NY", "IL", "PA", "OH", "GA", "AZ", "NC",
    "NJ", "VA", "WA", "CO", "TN"
}
TIER_2_STATES = {
    "MI", "MN", "MA", "MD", "SC", "IN", "MO", "WI", "AL", "KY",
    "OR", "OK", "CT", "IA", "MS", "AR", "KS", "NV", "UT", "NM",
    "NE", "WV"
}

SAMPLE_ZIP_CENTROIDS = [
    {"zip": "08831", "lat": 40.3218, "lng": -74.4199, "state": "NJ", "population_density": 800},
    {"zip": "08816", "lat": 40.4187, "lng": -74.4176, "state": "NJ", "population_density": 1200},
    {"zip": "07030", "lat": 40.7458, "lng": -74.0323, "state": "NJ", "population_density": 18000},
    {"zip": "08901", "lat": 40.4904, "lng": -74.4477, "state": "NJ", "population_density": 5400},
    {"zip": "10001", "lat": 40.7484, "lng": -73.9967, "state": "NY", "population_density": 35000},
    {"zip": "11201", "lat": 40.6928, "lng": -73.9903, "state": "NY", "population_density": 28000},
    {"zip": "77001", "lat": 29.7490, "lng": -95.3677, "state": "TX", "population_density": 2100},
    {"zip": "78201", "lat": 29.4559, "lng": -98.5197, "state": "TX", "population_density": 3200},
    {"zip": "90001", "lat": 33.9731, "lng": -118.2479, "state": "CA", "population_density": 22000},
    {"zip": "94102", "lat": 37.7793, "lng": -122.4193, "state": "CA", "population_density": 17000},
    {"zip": "33101", "lat": 25.7617, "lng": -80.1918, "state": "FL", "population_density": 4500},
    {"zip": "32801", "lat": 28.5480, "lng": -81.3749, "state": "FL", "population_density": 2800},
]


def _get_zip_centroids(tier: int = 1) -> list[dict]:
    """Load ZIP centroids from CSV or use sample."""
    import os
    csv_path = os.path.join(os.path.dirname(__file__), '..', 'geo', 'zip_centroids.csv')
    if os.path.exists(csv_path):
        import csv
        centroids = []
        with open(csv_path, newline='') as f:
            reader = csv.DictReader(f)
            for row in reader:
                centroids.append({
                    "zip": row.get("zip", row.get("ZIP", "")),
                    "lat": float(row.get("lat", row.get("LAT", 0))),
                    "lng": float(row.get("lng", row.get("LNG", 0))),
                    "state": row.get("state", row.get("STATE", "")),
                    "population_density": float(row.get("population_density", 1000)),
                })
        return centroids
    logger.warning("No zip_centroids.csv found, using sample data (12 ZIPs). "
                   "Add geo/zip_centroids.csv for full coverage.")
    return SAMPLE_ZIP_CENTROIDS


def _classify_density(density: float) -> str:
    if density >= 500: return "urban"
    elif density >= 200: return "suburban"
    return "rural"


def _get_radius_for_density(density: float) -> int:
    d = _classify_density(density)
    return {"urban": 3, "suburban": 5, "rural": 10}.get(d, 5)


class GooglePlacesDiscoveryAgent:
    """
    Agent 2 — Google Places Discovery
    Sweeps ZIP code x category combinations, emitting to Redis Stream vendors:raw:google.
    """

    def __init__(self, api_key: str, redis_client: aioredis.Redis, tier: int = 1, dry_run: bool = False):
        self.api_key = api_key
        self.redis = redis_client
        self.tier = tier
        self.dry_run = dry_run
        self.rate_limiter = AsyncRedisTokenBucket(
            redis_client=redis_client,
            key="rate_limit:google_places",
            capacity=settings.GOOGLE_QPS_LIMIT,
            rate=settings.GOOGLE_QPS_LIMIT,
        )
        self.circuit_breaker = CircuitBreaker("google_places", failure_threshold=5, recovery_timeout=60)

    def _tier_states(self) -> set:
        if self.tier == 1: return TIER_1_STATES
        elif self.tier == 2: return TIER_1_STATES | TIER_2_STATES
        return TIER_1_STATES | TIER_2_STATES

    async def _already_crawled(self, zip_code: str, category_code: str) -> bool:
        key = f"crawled:google:{zip_code}:{category_code}"
        return bool(await self.redis.get(key))

    async def _mark_crawled(self, zip_code: str, category_code: str):
        key = f"crawled:google:{zip_code}:{category_code}"
        ttl = settings.GOOGLE_RECRAWL_DAYS * 86400
        await self.redis.set(key, "1", ex=ttl)

    @retry(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=2, min=2, max=16),
        retry=retry_if_exception_type(httpx.HTTPStatusError),
    )
    async def _search_places(self, query: str, lat: float, lng: float, radius_meters: int) -> list[dict]:
        if not self.circuit_breaker.can_attempt():
            raise RuntimeError("Circuit breaker OPEN for Google Places API")
        await self.rate_limiter.acquire()
        payload = {
            "textQuery": query,
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius_meters}},
            "maxResultCount": 20,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                response = await client.post(
                    GOOGLE_PLACES_API_BASE, json=payload,
                    headers={"X-Goog-Api-Key": self.api_key, "X-Goog-FieldMask": FIELDS_MASK},
                )
                response.raise_for_status()
                self.circuit_breaker.record_success()
                return response.json().get("places", [])
            except httpx.HTTPStatusError as e:
                self.circuit_breaker.record_failure()
                raise
            except Exception as e:
                self.circuit_breaker.record_failure()
                raise

    async def _emit_to_stream(self, record: dict, category_code: str, zip_code: str):
        place_id = record.get("id", "")
        if place_id:
            seen_key = f"seen:place:{place_id}"
            if await self.redis.get(seen_key):
                return
            await self.redis.set(seen_key, "1", ex=86400 * 7)
        message = {
            "source": "google", "category_code": category_code, "zip_code": zip_code,
            "place_id": place_id, "raw_data": json.dumps(record, ensure_ascii=False),
            "ingested_at": datetime.now(timezone.utc).isoformat(),
        }
        if self.dry_run:
            logger.info(f"[DRY RUN] Would emit: {record.get('displayName', {}).get('text', '?')} ({category_code})")
            return
        await self.redis.xadd(STREAM_KEY, message)

    async def run_sweep(self, max_records: Optional[int] = None) -> dict:
        """Execute a full geo x category sweep. Returns stats dict."""
        allowed_states = self._tier_states()
        centroids = _get_zip_centroids(self.tier)
        filtered = [c for c in centroids if c["state"] in allowed_states]
        stats = {"records_emitted": 0, "tiles_processed": 0, "tiles_skipped": 0, "errors": 0}
        logger.info(f"GooglePlacesDiscoveryAgent: {len(filtered)} ZIPs x {len(TAXONOMY_LEAF_NODES)} categories")
        for zip_entry in filtered:
            zip_code = zip_entry["zip"]
            lat, lng = zip_entry["lat"], zip_entry["lng"]
            radius_m = int(_get_radius_for_density(zip_entry.get("population_density", 1000)) * 1609.34)
            for cat in TAXONOMY_LEAF_NODES:
                if max_records and stats["records_emitted"] >= max_records:
                    return stats
                if await self._already_crawled(zip_code, cat["code"]):
                    stats["tiles_skipped"] += 1
                    continue
                try:
                    places = await self._search_places(query=cat["display_name"], lat=lat, lng=lng, radius_meters=radius_m)
                    for place in places:
                        await self._emit_to_stream(place, cat["code"], zip_code)
                        stats["records_emitted"] += 1
                    await self._mark_crawled(zip_code, cat["code"])
                    stats["tiles_processed"] += 1
                except Exception as e:
                    stats["errors"] += 1
                    logger.error(f"Error sweeping {zip_code}/{cat['code']}: {e}")
                    await self.redis.xadd("vendors:dlq", {
                        "source": "google", "zip": zip_code, "cat": cat["code"],
                        "error": str(e)[:500], "ts": datetime.now(timezone.utc).isoformat(),
                    })
        logger.info(f"GooglePlacesDiscoveryAgent sweep complete: {stats}")
        return stats
