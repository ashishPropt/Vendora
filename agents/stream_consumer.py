"""
agents/stream_consumer.py  —  Redis Stream Consumer

Consumes raw vendor records from all Redis Streams (Google, Yelp, Angi),
creates canonical Vendor records in PostgreSQL, then chains:
Classification -> Dedup -> Scoring per record.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

import redis
from sqlalchemy.orm import Session

from config import settings
from db.models import Vendor, VendorSource, SourceNameEnum, JobRun, JobStatusEnum
from db.connection import get_db
from agents.dedup import DedupAgent
from agents.classification import ClassificationAgent
from agents.scoring import ScoringAgent
from utils import normalize_phone_e164, generate_vendor_slug

logger = logging.getLogger(__name__)

STREAMS = {
    "vendors:raw:google": "google",
    "vendors:raw:yelp": "yelp",
    "vendors:raw:angi": "angi",
}
CONSUMER_GROUP = "vendor_ingest"
CONSUMER_NAME = f"consumer_{uuid.uuid4().hex[:8]}"


def _parse_google_record(raw: dict, category_code: str) -> Optional[dict]:
    display_name = raw.get("displayName", {})
    name = display_name.get("text", "") if isinstance(display_name, dict) else str(display_name)
    location = raw.get("location", {})
    address_parts = (raw.get("formattedAddress") or "").split(",")
    street = address_parts[0].strip() if address_parts else ""
    state, zip_code, city = "", "", ""
    import re
    for part in address_parts:
        m = re.search(r'\b([A-Z]{2})\s+(\d{5})\b', part.strip())
        if m:
            state, zip_code = m.group(1), m.group(2)
            break
    if len(address_parts) >= 2:
        city_state = address_parts[-2].strip() if len(address_parts) > 2 else ""
        city = re.sub(r'[A-Z]{2}\s+\d{5}.*', '', city_state).strip()
    phone = normalize_phone_e164(raw.get("nationalPhoneNumber", "")) or raw.get("nationalPhoneNumber", "")
    return {
        "canonical_name": name, "primary_phone": phone,
        "website_url": raw.get("websiteUri", ""), "street_address": street,
        "city": city, "state": state, "zip": zip_code,
        "lat": location.get("latitude"), "lng": location.get("longitude"),
        "place_id": raw.get("id", ""), "primary_category_code": category_code,
        "source": "google", "external_id": raw.get("id", ""),
    }


def _parse_yelp_record(raw: dict) -> Optional[dict]:
    location = raw.get("location", {})
    coords = raw.get("coordinates", {})
    phone = normalize_phone_e164(raw.get("phone", raw.get("display_phone", ""))) or raw.get("phone", "")
    return {
        "canonical_name": raw.get("name", ""), "primary_phone": phone,
        "website_url": raw.get("url", ""),
        "street_address": location.get("address1", ""), "city": location.get("city", ""),
        "state": location.get("state", ""), "zip": location.get("zip_code", "")[:5],
        "lat": coords.get("latitude"), "lng": coords.get("longitude"),
        "yelp_business_id": raw.get("id", ""), "primary_category_code": None,
        "source": "yelp", "external_id": raw.get("id", ""),
    }


def _parse_angi_record(raw: dict, state: str) -> Optional[dict]:
    return {
        "canonical_name": raw.get("name", ""), "primary_phone": None,
        "website_url": None, "street_address": None, "city": None, "state": state, "zip": None,
        "angi_pro_id": raw.get("angi_pro_id", ""),
        "is_background_checked": raw.get("has_background_check", False),
        "primary_category_code": None, "source": "angi", "external_id": raw.get("angi_pro_id", ""),
    }


def _ensure_slug(db: Session, name: str, city: str, state: str) -> str:
    base = generate_vendor_slug(name, city or "", state or "")
    slug, counter = base, 1
    while db.query(Vendor).filter(Vendor.slug == slug).first():
        slug = f"{base}-{counter}"
        counter += 1
    return slug


def ingest_record(db: Session, parsed: dict, raw_data: dict) -> Optional[Vendor]:
    """Create or update a Vendor record from a parsed source record."""
    source = parsed.get("source", "google")
    external_id = parsed.get("external_id", "")
    source_enum = SourceNameEnum(source) if source in SourceNameEnum._value2member_map_ else SourceNameEnum.manual

    if external_id:
        existing_source = db.query(VendorSource).filter(
            VendorSource.source_name == source_enum,
            VendorSource.external_id == external_id,
        ).first()
        if existing_source:
            return None  # Already ingested

    vendor = None
    if parsed.get("place_id"):
        vendor = db.query(Vendor).filter(Vendor.place_id == parsed["place_id"]).first()
    if not vendor and parsed.get("yelp_business_id"):
        vendor = db.query(Vendor).filter(Vendor.yelp_business_id == parsed["yelp_business_id"]).first()

    name = parsed.get("canonical_name", "").strip()
    if not name:
        return None

    if not vendor:
        category_code = parsed.get("primary_category_code") or "HND.GEN"
        slug = _ensure_slug(db, name, parsed.get("city", ""), parsed.get("state", ""))
        vendor = Vendor(
            canonical_name=name, slug=slug,
            primary_phone=parsed.get("primary_phone"), website_url=parsed.get("website_url"),
            street_address=parsed.get("street_address"), city=parsed.get("city"),
            state=parsed.get("state"), zip=parsed.get("zip"),
            lat=parsed.get("lat"), lng=parsed.get("lng"),
            place_id=parsed.get("place_id"), yelp_business_id=parsed.get("yelp_business_id"),
            angi_pro_id=parsed.get("angi_pro_id"),
            primary_category_code=category_code,
            is_background_checked=parsed.get("is_background_checked", False),
            source_ids=[external_id] if external_id else [],
        )
        db.add(vendor)
        db.flush()
    else:
        if not vendor.primary_phone and parsed.get("primary_phone"):
            vendor.primary_phone = parsed["primary_phone"]
        if not vendor.website_url and parsed.get("website_url"):
            vendor.website_url = parsed["website_url"]
        if not vendor.lat and parsed.get("lat"):
            vendor.lat, vendor.lng = parsed["lat"], parsed["lng"]
        if external_id and external_id not in (vendor.source_ids or []):
            vendor.source_ids = (vendor.source_ids or []) + [external_id]
        vendor.updated_at = datetime.now(timezone.utc)

    db.add(VendorSource(vendor_id=vendor.vendor_id, source_name=source_enum,
                         external_id=external_id or None, raw_data=raw_data))
    db.flush()
    return vendor


class StreamConsumer:
    """Consumes from all vendor Redis Streams and processes through ingestion -> dedup -> classify -> score."""

    def __init__(self, redis_url: str = "", run_classification: bool = True,
                 run_scoring: bool = True, run_dedup: bool = True):
        self.redis_url = redis_url or settings.REDIS_URL
        self.run_classification = run_classification
        self.run_scoring = run_scoring
        self.run_dedup = run_dedup
        self._redis: Optional[redis.Redis] = None

    def _get_redis(self) -> redis.Redis:
        if not self._redis:
            self._redis = redis.from_url(self.redis_url, decode_responses=True)
        return self._redis

    def _ensure_consumer_groups(self):
        r = self._get_redis()
        for stream_key in STREAMS:
            try:
                r.xgroup_create(stream_key, CONSUMER_GROUP, id="0", mkstream=True)
            except redis.exceptions.ResponseError as e:
                if "BUSYGROUP" not in str(e):
                    logger.warning(f"xgroup_create error for {stream_key}: {e}")

    def process_message(self, db: Session, stream_key: str, message_id: str, data: dict) -> bool:
        """Process a single stream message. Returns True if successfully processed."""
        source = STREAMS.get(stream_key, "google")
        try:
            raw_json = data.get("raw_data", "{}")
            raw_data = json.loads(raw_json) if isinstance(raw_json, str) else raw_json
            category_code = data.get("category_code", "HND.GEN")
            state = data.get("state", "")
            if source == "google":
                parsed = _parse_google_record(raw_data, category_code)
            elif source == "yelp":
                parsed = _parse_yelp_record(raw_data)
            elif source == "angi":
                parsed = _parse_angi_record(raw_data, state)
            else:
                return True
            if not parsed:
                return True
            vendor = ingest_record(db, parsed, raw_data)
            if not vendor:
                db.rollback()
                return True
            if self.run_classification and not vendor.classification_confidence:
                ClassificationAgent(db).classify_vendor(vendor, raw_data)
            if self.run_dedup:
                DedupAgent(db).process_vendor(vendor)
            if self.run_scoring:
                ScoringAgent(db).score_vendor(vendor, trigger_event="stream_ingest")
            db.commit()
            return True
        except Exception as e:
            logger.error(f"Error processing message {message_id} from {stream_key}: {e}")
            db.rollback()
            return False

    def consume_batch(self, batch_size: int = 50, block_ms: int = 1000) -> dict:
        r = self._get_redis()
        self._ensure_consumer_groups()
        stats = {"processed": 0, "errors": 0, "skipped": 0}
        for stream_key in STREAMS:
            try:
                results = r.xreadgroup(
                    groupname=CONSUMER_GROUP, consumername=CONSUMER_NAME,
                    streams={stream_key: ">"}, count=batch_size, block=block_ms,
                )
            except Exception as e:
                logger.warning(f"xreadgroup error on {stream_key}: {e}")
                continue
            if not results:
                continue
            for _stream, messages in results:
                with get_db() as db:
                    for message_id, data in messages:
                        ok = self.process_message(db, stream_key, message_id, data)
                        if ok:
                            r.xack(stream_key, CONSUMER_GROUP, message_id)
                            stats["processed"] += 1
                        else:
                            stats["errors"] += 1
        return stats

    def run_forever(self, batch_size: int = 50):
        """Continuously consume messages until interrupted."""
        logger.info("StreamConsumer starting continuous processing loop...")
        while True:
            try:
                stats = self.consume_batch(batch_size=batch_size)
                if stats["processed"] > 0:
                    logger.info(f"Consumed batch: {stats}")
            except KeyboardInterrupt:
                logger.info("StreamConsumer stopping.")
                break
            except Exception as e:
                logger.error(f"StreamConsumer error: {e}")
