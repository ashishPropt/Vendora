"""
config.py  —  Centralised settings loaded from .env
"""

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- PostgreSQL ---
    DATABASE_URL: str = "postgresql://postgres:password@localhost:5432/vendor_acquisition"
    DB_HOST: str = "localhost"
    DB_PORT: int = 5432
    DB_NAME: str = "vendor_acquisition"
    DB_USER: str = "postgres"
    DB_PASSWORD: str = "password"

    @property
    def ASYNC_DATABASE_URL(self) -> str:
        return self.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

    # --- Redis ---
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_HOST: str = "localhost"
    REDIS_PORT: int = 6379
    REDIS_DB: int = 0

    # --- External API Keys ---
    GOOGLE_PLACES_API_KEY: str = ""
    YELP_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    SMARTYSTREETS_AUTH_ID: str = ""
    SMARTYSTREETS_AUTH_TOKEN: str = ""
    BRIGHTDATA_PROXY_USERNAME: str = ""
    BRIGHTDATA_PROXY_PASSWORD: str = ""

    # --- App ---
    APP_ENV: str = "development"
    LOG_LEVEL: str = "INFO"
    API_PORT: int = 8000
    API_HOST: str = "0.0.0.0"

    # --- Celery ---
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # --- Scoring ---
    SCORING_MODEL_VERSION: str = "scoring-model-v1.0.0"

    # --- Discovery ---
    GOOGLE_RECRAWL_DAYS: int = 60
    GOOGLE_QPS_LIMIT: int = 10
    YELP_DAILY_CALL_LIMIT: int = 5000
    DISCOVERY_TIER: int = 1


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
