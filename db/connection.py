"""
db/connection.py  —  Database connection pool and session management
"""

import logging
from contextlib import contextmanager, asynccontextmanager
from typing import Generator, AsyncGenerator

from sqlalchemy import create_engine, event, text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import NullPool

from db.models import Base
from config import settings

logger = logging.getLogger(__name__)

# ─── Synchronous engine (for migrations, Celery workers) ───
engine = create_engine(
    settings.DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=(settings.LOG_LEVEL == "DEBUG"),
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


@contextmanager
def get_db() -> Generator[Session, None, None]:
    """Synchronous session context manager."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# ─── Async engine (for FastAPI, async agents) ───
async_engine = create_async_engine(
    settings.ASYNC_DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=(settings.LOG_LEVEL == "DEBUG"),
)

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    expire_on_commit=False,
    autoflush=False,
)


@asynccontextmanager
async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    """Async session context manager."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


def create_all_tables():
    """Create all tables. Idempotent — safe to call on startup."""
    logger.info("Creating database tables...")
    Base.metadata.create_all(bind=engine)
    _ensure_postgis_extension()
    _add_geom_column()
    logger.info("Database tables ready.")


def _ensure_postgis_extension():
    """Install PostGIS extension if not already present."""
    with engine.connect() as conn:
        try:
            conn.execute(text("CREATE EXTENSION IF NOT EXISTS postgis"))
            conn.commit()
            logger.info("PostGIS extension ensured.")
        except Exception as e:
            logger.warning(f"Could not create PostGIS extension (may need superuser): {e}")
            logger.warning("Geo-spatial features will be limited. Install PostGIS manually if needed.")


def _add_geom_column():
    """Add PostGIS geom column to vendors if not present."""
    with engine.connect() as conn:
        try:
            result = conn.execute(text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name='vendors' AND column_name='geom'"
            ))
            if not result.fetchone():
                conn.execute(text(
                    "ALTER TABLE vendors ADD COLUMN IF NOT EXISTS geom GEOGRAPHY(POINT, 4326)"
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_vendors_geom ON vendors USING GIST (geom)"
                ))
                conn.commit()
                logger.info("Added PostGIS geom column to vendors table.")
        except Exception as e:
            logger.warning(f"Could not add geom column (PostGIS may not be available): {e}")


def drop_all_tables():
    """Drop all tables. USE WITH EXTREME CAUTION."""
    Base.metadata.drop_all(bind=engine)
