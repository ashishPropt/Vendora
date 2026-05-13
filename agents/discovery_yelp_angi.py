"""
agents/discovery_yelp_angi.py  —  Agents 3 & 4: Yelp Fusion + Angi Playwright
"""

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Optional

import httpx
import redis.asyncio as aioredis
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings
from taxonomy import TAXONOMY_LEAF_NODES
from utils import CircuitBreaker

logger = logging.getLogger(__name__)

# Agent 3 — Yelp
YELP_BUSINESS_SEARCH = "https://api.yelp.com/v3/businesses/search"
YELP_STREAM_KEY = "vendors:raw:yelp"
RESULTS_PER_CALL = 50
MAX_OFFSET = 1000

TIER1_DMAS = [
    {"dma": "New York",          "location": "New York, NY",       "states": ["NY", "NJ", "CT"]},
    {"dma": "Los Angeles",       "location": "Los Angeles, CA",     "states": ["CA"]},
    {"dma": "Chicago",           "location": "Chicago, IL",         "states": ["IL"]},
    {"dma": "Philadelphia",      "location": "Philadelphia, PA",    "states": ["PA", "NJ"]},
    {"dma": "Dallas-Fort Worth", "location": "Dallas, TX",          "states": ["TX"]},
    {"dma": "San Francisco",     "location": "San Francisco, CA",   "states": ["CA"]},
    {"dma": "Boston",            "location": "Boston, MA",          "states": ["MA"]},
    {"dma": "Atlanta",           "location": "Atlanta, GA",         "states": ["GA"]},
    {"dma": "Washington DC",     "location": "Washington, DC",      "states": ["DC", "MD", "VA"]},
    {"dma": "Houston",           "location": "Houston, TX",         "states": ["TX"]},
    {"dma": "Tampa",             "location": "Tampa, FL",           "states": ["FL"]},
    {"dma": "Seattle",           "location": "Seattle, WA",         "states": ["WA"]},
    {"dma": "Phoenix",           "location": "Phoenix, AZ",         "states": ["AZ"]},
    {"dma": "Miami",             "location": "Miami, FL",           "states": ["FL"]},
    {"dma": "Denver",            "location": "Denver, CO",          "states": ["CO"]},
    {"dma": "Orlando",           "location": "Orlando, FL",         "states": ["FL"]},
    {"dma": "Cleveland",         "location": "Cleveland, OH",       "states": ["OH"]},
    {"dma": "Charlotte",         "location": "Charlotte, NC",       "states": ["NC"]},
    {"dma": "Nashville",         "location": "Nashville, TN",       "states": ["TN"]},
    {"dma": "Austin",            "location": "Austin, TX",          "states": ["TX"]},
]


class YelpFusionDiscoveryAgent:
    """Agent 3 — Yelp Fusion Discovery. Paginates vendors per DMA x alias."""

    def __init__(self, api_key: str, redis_client: aioredis.Redis, dry_run: bool = False):
        self.api_key = api_key
        self.redis = redis_client
        self.dry_run = dry_run
        self.daily_calls_key = "yelp:daily_calls"
        self.circuit_breaker = CircuitBreaker("yelp_fusion", failure_threshold=5, recovery_timeout=120)

    async def _check_daily_budget(self):
        calls = await self.redis.incr(self.daily_calls_key)
        if calls == 1: await self.redis.expire(self.daily_calls_key, 86400)
        if calls > settings.YELP_DAILY_CALL_LIMIT:
            logger.warning("Yelp daily call limit reached, backing off.")
            await asyncio.sleep(60)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    async def _search(self, alias: str, location: str, offset: int) -> dict:
        if not self.circuit_breaker.can_attempt():
            raise RuntimeError("Circuit breaker OPEN for Yelp API")
        await self._check_daily_budget()
        params = {"categories": alias, "location": location, "limit": RESULTS_PER_CALL, "offset": offset}
        async with httpx.AsyncClient(timeout=12.0) as client:
            try:
                resp = await client.get(YELP_BUSINESS_SEARCH, params=params,
                                        headers={"Authorization": f"Bearer {self.api_key}"})
                resp.raise_for_status()
                self.circuit_breaker.record_success()
                return resp.json()
            except httpx.HTTPStatusError:
                self.circuit_breaker.record_failure()
                raise

    async def sweep_dma(self, dma_name: str, location_str: str, yelp_alias: str) -> int:
        offset, total_emitted = 0, 0
        while offset <= MAX_OFFSET:
            try:
                data = await self._search(yelp_alias, location_str, offset)
            except Exception as e:
                logger.error(f"Yelp sweep error {dma_name}/{yelp_alias}: {e}")
                break
            businesses = data.get("businesses", [])
            total = data.get("total", 0)
            if not businesses: break
            for biz in businesses:
                biz_id = biz.get("id", "")
                if biz_id and await self.redis.get(f"seen:yelp:{biz_id}"): continue
                message = {
                    "source": "yelp", "dma": dma_name, "yelp_alias": yelp_alias,
                    "business_id": biz_id, "raw_data": json.dumps(biz, ensure_ascii=False),
                    "ingested_at": datetime.now(timezone.utc).isoformat(),
                }
                if not self.dry_run:
                    await self.redis.xadd(YELP_STREAM_KEY, message)
                    if biz_id: await self.redis.set(f"seen:yelp:{biz_id}", "1", ex=86400 * 30)
                else:
                    logger.info(f"[DRY RUN] Yelp: {biz.get('name', '?')} ({yelp_alias})")
                total_emitted += 1
            offset += RESULTS_PER_CALL
            if offset >= min(total, MAX_OFFSET): break
            await asyncio.sleep(0.22)
        return total_emitted

    async def run_sweep(self, dmas: Optional[list] = None, max_records: Optional[int] = None) -> dict:
        dmas = dmas or TIER1_DMAS
        stats = {"records_emitted": 0, "errors": 0}
        unique_aliases = list({alias for cat in TAXONOMY_LEAF_NODES for alias in cat.get("yelp_aliases", [])})
        for dma in dmas:
            for alias in unique_aliases:
                if max_records and stats["records_emitted"] >= max_records: return stats
                try:
                    n = await self.sweep_dma(dma["dma"], dma["location"], alias)
                    stats["records_emitted"] += n
                except Exception as e:
                    stats["errors"] += 1
                    logger.error(f"Yelp sweep error {dma['dma']}/{alias}: {e}")
        logger.info(f"YelpFusionDiscoveryAgent sweep complete: {stats}")
        return stats


# Agent 4 — Angi
ANGI_STREAM_KEY = "vendors:raw:angi"

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123.0 Safari/537.36",
]


class AngiScraperAgent:
    """Agent 4 — Angi Playwright Scraper. Headless browser scraper for Angi.com."""

    def __init__(self, redis_client: aioredis.Redis, proxy_username: str = "",
                 proxy_password: str = "", dry_run: bool = False):
        self.redis = redis_client
        self.proxy_username = proxy_username
        self.proxy_password = proxy_password
        self.dry_run = dry_run

    def _proxy_config(self) -> Optional[dict]:
        if self.proxy_username and self.proxy_password:
            return {"server": "http://brd.superproxy.io:22225",
                    "username": self.proxy_username, "password": self.proxy_password}
        return None

    async def scrape_category_city(self, category_slug: str, state: str, city_slug: str) -> int:
        """Scrape Angi pro listings for a category/state/city. Returns record count."""
        try:
            from playwright.async_api import async_playwright
        except ImportError:
            logger.error("Playwright not installed. Run: pip install playwright && playwright install chromium")
            return 0
        url = f"https://www.angi.com/companylist/{category_slug}/{state}/{city_slug}/"
        records_emitted = 0
        proxy = self._proxy_config()
        async with async_playwright() as p:
            browser_args = {"headless": True}
            if proxy: browser_args["proxy"] = proxy
            browser = await p.chromium.launch(**browser_args)
            context = await browser.new_context(
                user_agent=random.choice(USER_AGENTS),
                java_script_enabled=True, viewport={"width": 1366, "height": 768},
            )
            await context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page = await context.new_page()
            try:
                await page.goto(url, wait_until="networkidle", timeout=30000)
                while True:
                    try:
                        await page.wait_for_selector('[data-testid="pro-card"]', timeout=8000)
                    except Exception:
                        break
                    cards = await page.query_selector_all('[data-testid="pro-card"]')
                    for card in cards:
                        try:
                            pro_data = await self._extract_pro_card(card)
                            message = {
                                "source": "angi", "category_slug": category_slug,
                                "state": state, "city_slug": city_slug,
                                "raw_data": json.dumps(pro_data, ensure_ascii=False),
                                "ingested_at": datetime.now(timezone.utc).isoformat(),
                            }
                            if not self.dry_run:
                                await self.redis.xadd(ANGI_STREAM_KEY, message)
                            records_emitted += 1
                        except Exception as e:
                            logger.debug(f"Card extraction error: {e}")
                    await asyncio.sleep(random.uniform(1.5, 4.0))
                    next_btn = await page.query_selector('[aria-label="Next page"]')
                    if not next_btn or not await next_btn.is_enabled(): break
                    await next_btn.click()
                    await page.wait_for_load_state("networkidle")
            except Exception as e:
                logger.error(f"Angi scraper error {url}: {e}")
            finally:
                await browser.close()
        return records_emitted

    async def _extract_pro_card(self, card) -> dict:
        async def safe_text(selector: str) -> str:
            el = await card.query_selector(selector)
            return (await el.inner_text()).strip() if el else ""
        async def safe_attr(selector: str, attr: str) -> str:
            el = await card.query_selector(selector)
            return (await el.get_attribute(attr) or "").strip() if el else ""
        name = await safe_text('.provider-name')
        rating_label = await safe_attr('[aria-label*="stars"]', "aria-label")
        reviews = await safe_text('.review-count')
        years = await safe_text('.years-in-business')
        service_els = await card.query_selector_all('.service-category-list li')
        services = [(await s.inner_text()).strip() for s in service_els]
        license_badge = await card.query_selector('[data-testid="license-badge"]')
        bg_badge = await card.query_selector('[data-testid="background-check-badge"]')
        href = await safe_attr('a[href*="/pro/"]', "href")
        angi_pro_id = href.split("/pro/")[-1].split("/")[0] if "/pro/" in href else ""
        return {
            "name": name, "rating": rating_label,
            "review_count": reviews.strip("()").strip(),
            "years_in_business": years, "services": services,
            "has_license_badge": license_badge is not None,
            "has_background_check": bg_badge is not None,
            "angi_pro_id": angi_pro_id,
        }
