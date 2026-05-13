"""
utils/__init__.py  —  Shared utilities for the Vendor Acquisition Engine
"""

import re
import time
import asyncio
import hashlib
import logging
import unicodedata
from enum import Enum
from typing import Optional

import redis as sync_redis
import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

RATE_LIMITER_LUA = """
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucket = redis.call("HMGET", key, "tokens", "last_refill")
local tokens = tonumber(bucket[1]) or capacity
local last_refill = tonumber(bucket[2]) or now
local elapsed = now - last_refill
tokens = math.min(capacity, tokens + elapsed * refill_rate)
if tokens >= 1 then
    tokens = tokens - 1
    redis.call("HMSET", key, "tokens", tokens, "last_refill", now)
    redis.call("EXPIRE", key, 3600)
    return 1
else
    redis.call("HMSET", key, "tokens", tokens, "last_refill", now)
    redis.call("EXPIRE", key, 3600)
    return 0
end
"""


class AsyncRedisTokenBucket:
    """Async Redis-backed token bucket rate limiter."""

    def __init__(self, redis_client: aioredis.Redis, key: str, capacity: int, rate: float):
        self.redis = redis_client
        self.key = key
        self.capacity = capacity
        self.rate = rate
        self._script = None

    async def acquire(self, timeout: float = 60.0) -> bool:
        if not self._script:
            self._script = self.redis.register_script(RATE_LIMITER_LUA)
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            result = await self._script(
                keys=[self.key],
                args=[self.capacity, self.rate, time.time()]
            )
            if result == 1:
                return True
            await asyncio.sleep(1.0 / max(self.rate, 0.1))
        raise TimeoutError(f"Could not acquire rate limit token for {self.key} within {timeout}s")


class CircuitState(Enum):
    CLOSED    = "closed"
    OPEN      = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """Simple in-process circuit breaker."""

    def __init__(self, name: str, failure_threshold: int = 5, recovery_timeout: int = 60):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.failure_count = 0
        self.last_failure_time: Optional[float] = None
        self.state = CircuitState.CLOSED

    def record_success(self):
        if self.state == CircuitState.HALF_OPEN:
            logger.info(f"[CircuitBreaker:{self.name}] HALF_OPEN -> CLOSED (success)")
        self.failure_count = 0
        self.state = CircuitState.CLOSED

    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.monotonic()
        if self.failure_count >= self.failure_threshold:
            if self.state != CircuitState.OPEN:
                logger.warning(f"[CircuitBreaker:{self.name}] OPEN after {self.failure_count} failures")
            self.state = CircuitState.OPEN

    def can_attempt(self) -> bool:
        if self.state == CircuitState.CLOSED:
            return True
        if self.state == CircuitState.OPEN:
            if (time.monotonic() - (self.last_failure_time or 0)) > self.recovery_timeout:
                self.state = CircuitState.HALF_OPEN
                logger.info(f"[CircuitBreaker:{self.name}] OPEN -> HALF_OPEN")
                return True
            return False
        return True


def normalize_phone_e164(phone: str) -> Optional[str]:
    """Normalize a phone number to E.164 format (+12125551234)."""
    if not phone:
        return None
    digits = re.sub(r'\D', '', phone)
    if len(digits) == 10:
        digits = '1' + digits
    if len(digits) == 11 and digits[0] == '1':
        area = digits[1:4]
        if area in ('800', '888', '877', '866', '855', '844', '833'):
            return None
        return f'+{digits}'
    return None


LEGAL_SUFFIXES = re.compile(
    r'\b(llc|inc|corp|co|ltd|lp|pllc|pc|dba|and|&|the)\b',
    re.IGNORECASE
)


def normalize_business_name(name: str) -> str:
    """Normalize a business name for blocking key generation and fuzzy comparison."""
    if not name:
        return ""
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = name.lower().strip()
    name = LEGAL_SUFFIXES.sub("", name)
    name = re.sub(r'[^a-z0-9\s]', '', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def generate_blocking_key(name: str, zip_code: str) -> str:
    """Generate a blocking key for dedup candidate lookup."""
    normalized = normalize_business_name(name)
    name_prefix = normalized[:5].ljust(5, '_')
    zip_clean = str(zip_code or "").strip()[:5].ljust(5, '0')
    return f"{name_prefix}{zip_clean}"


def generate_address_hash(normalized_address: str) -> str:
    """SHA-256 hash of a CASS-normalized address for exact address matching."""
    return hashlib.sha256(normalized_address.lower().strip().encode()).hexdigest()


def extract_domain(url: str) -> Optional[str]:
    """Extract the eTLD+1 domain from a URL for website-match dedup signal."""
    if not url:
        return None
    url = re.sub(r'^https?://', '', url, flags=re.IGNORECASE)
    url = re.sub(r'^www\.', '', url, flags=re.IGNORECASE)
    domain = url.split('/')[0].split('?')[0].lower().strip()
    if not domain:
        return None
    GENERIC_PLATFORMS = {
        'wix.com', 'squarespace.com', 'homeadvisor.com', 'angi.com',
        'yelp.com', 'google.com', 'facebook.com', 'instagram.com',
        'thumbtack.com', 'nextdoor.com', 'angieslist.com'
    }
    if domain in GENERIC_PLATFORMS or any(domain.endswith('.' + p) for p in GENERIC_PLATFORMS):
        return None
    return domain


def generate_vendor_slug(name: str, city: str, state: str) -> str:
    """Generate a URL-safe slug for a vendor."""
    try:
        from slugify import slugify
        raw = f"{name} {city} {state}"
        return slugify(raw, max_length=100)
    except ImportError:
        raw = f"{name} {city} {state}".lower()
        raw = re.sub(r'[^a-z0-9\s-]', '', raw)
        raw = re.sub(r'\s+', '-', raw.strip())
        raw = re.sub(r'-+', '-', raw)
        return raw[:100]
