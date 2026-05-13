"""
db/models.py  —  SQLAlchemy ORM models for the Vendor Acquisition Engine

Note: The PostGIS `geom` GEOGRAPHY column on the vendors table is NOT declared here
because SQLAlchemy's postgresql dialect doesn't include GEOGRAPHY natively (it requires
GeoAlchemy2). Instead, connection.py adds the column via raw ALTER TABLE after create_all().
"""

import enum
import uuid
from datetime import datetime, date
from typing import Optional, List

from sqlalchemy import (
    Column, String, Text, Boolean, Integer, Numeric, Date,
    DateTime, ARRAY, JSON, ForeignKey, UniqueConstraint, Index,
    SmallInteger, Enum as SAEnum, CheckConstraint, func
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()


class SourceNameEnum(str, enum.Enum):
    google        = "google"
    yelp          = "yelp"
    angi          = "angi"
    state_license = "state_license"
    county_list   = "county_list"
    manual        = "manual"
    enrichment    = "enrichment"


class JobStatusEnum(str, enum.Enum):
    PENDING   = "PENDING"
    RUNNING   = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED    = "FAILED"
    RETRYING  = "RETRYING"
    CANCELLED = "CANCELLED"


class DedupResolutionEnum(str, enum.Enum):
    merged        = "merged"
    rejected      = "rejected"
    pending       = "pending"
    manual_review = "manual_review"


class CategoryTaxonomy(Base):
    __tablename__ = "category_taxonomy"

    category_code      = Column(String(20), primary_key=True)
    parent_code        = Column(String(10), nullable=True)
    display_name       = Column(Text, nullable=False)
    yelp_aliases       = Column(ARRAY(Text))
    google_place_types = Column(ARRAY(Text))
    keywords           = Column(ARRAY(Text))
    priority           = Column(SmallInteger, CheckConstraint("priority BETWEEN 1 AND 5"))
    is_active          = Column(Boolean, default=True, nullable=False)
    description        = Column(Text)
    created_at         = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class Vendor(Base):
    __tablename__ = "vendors"

    vendor_id        = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    canonical_name   = Column(Text, nullable=False)
    slug             = Column(Text, unique=True, nullable=False)
    primary_phone    = Column(Text)
    secondary_phone  = Column(Text)
    email            = Column(Text)
    website_url      = Column(Text)
    street_address   = Column(Text)
    city             = Column(Text)
    state            = Column(String(2))
    zip              = Column(String(5))
    county           = Column(Text)
    lat              = Column(Numeric(10, 7))
    lng              = Column(Numeric(10, 7))
    # geom GEOGRAPHY(POINT,4326) added via raw SQL in connection.py — requires PostGIS
    usps_normalized_address = Column(Text)
    address_hash     = Column(Text)
    place_id         = Column(Text, unique=True)
    yelp_business_id = Column(Text, unique=True)
    angi_pro_id      = Column(Text, unique=True)
    primary_category_code      = Column(String(20), ForeignKey("category_taxonomy.category_code"), nullable=False)
    secondary_category_codes   = Column(ARRAY(Text))
    classification_confidence  = Column(Numeric(4, 3))
    classification_method      = Column(Text, CheckConstraint("classification_method IN ('rule','llm','embedding','manual')"))
    vendor_score    = Column(Numeric(5, 2))
    score_tier      = Column(String(1), CheckConstraint("score_tier IN ('A','B','C','D','F')"))
    last_scored_at  = Column(DateTime(timezone=True))
    is_active              = Column(Boolean, default=True, nullable=False)
    is_claimed             = Column(Boolean, default=False, nullable=False)
    is_licensed            = Column(Boolean, default=False, nullable=False)
    is_insured             = Column(Boolean, default=False, nullable=False)
    is_background_checked  = Column(Boolean, default=False, nullable=False)
    validation_flags       = Column(ARRAY(Text), default=list)
    years_in_business     = Column(Integer)
    employee_count_range  = Column(Text)
    service_radius_miles  = Column(Integer)
    service_states        = Column(ARRAY(Text))
    bbb_accredited        = Column(Boolean)
    bbb_rating            = Column(Text)
    bbb_complaint_count   = Column(Integer)
    source_ids       = Column(ARRAY(Text), default=list)
    notes            = Column(Text)
    created_at       = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    updated_at       = Column(DateTime(timezone=True), default=func.now(), onupdate=func.now(), nullable=False)
    last_validated_at = Column(DateTime(timezone=True))

    # foreign_keys specified explicitly because VendorSource has two FKs pointing to vendors
    sources = relationship(
        "VendorSource",
        foreign_keys="VendorSource.vendor_id",
        back_populates="vendor",
        cascade="all, delete-orphan",
    )
    scores           = relationship("VendorScore", back_populates="vendor", cascade="all, delete-orphan")
    licenses         = relationship("VendorLicense", back_populates="vendor", cascade="all, delete-orphan")
    review_summaries = relationship("VendorReviewSummary", back_populates="vendor", cascade="all, delete-orphan")


class VendorSource(Base):
    __tablename__ = "vendor_sources"

    source_id       = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id       = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id", ondelete="CASCADE"), nullable=False)
    source_name     = Column(SAEnum(SourceNameEnum, name="source_name_enum"), nullable=False)
    external_id     = Column(Text)
    raw_data        = Column(JSONB, nullable=False)
    ingested_at     = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    is_merged       = Column(Boolean, default=False, nullable=False)
    # merge_target_id is a second FK to vendors — foreign_keys=[vendor_id] below tells
    # SQLAlchemy to use only vendor_id for the back-reference, not merge_target_id
    merge_target_id = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id"), nullable=True)

    vendor = relationship(
        "Vendor",
        foreign_keys=[vendor_id],
        back_populates="sources",
    )

    __table_args__ = (
        UniqueConstraint("source_name", "external_id", name="uq_vendor_sources_source_external"),
    )


class VendorScore(Base):
    __tablename__ = "vendor_scores"

    score_id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id              = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id", ondelete="CASCADE"), nullable=False)
    score_date             = Column(DateTime(timezone=True), default=func.now(), nullable=False)
    vendor_score           = Column(Numeric(5, 2), nullable=False)
    quality_score          = Column(Numeric(5, 2))
    compliance_score       = Column(Numeric(5, 2))
    reputation_score       = Column(Numeric(5, 2))
    activity_score         = Column(Numeric(5, 2))
    coverage_score         = Column(Numeric(5, 2))
    score_tier             = Column(String(1), CheckConstraint("score_tier IN ('A','B','C','D','F')"))
    score_breakdown        = Column(JSONB)
    scored_by_model_version = Column(Text)
    decay_adjustment       = Column(Numeric(4, 2))
    trigger_event          = Column(Text)

    vendor = relationship("Vendor", back_populates="scores")


class VendorLicense(Base):
    __tablename__ = "vendor_licenses"

    license_id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id          = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id", ondelete="CASCADE"), nullable=False)
    state              = Column(String(2), nullable=False)
    license_type       = Column(Text, nullable=False)
    license_number     = Column(Text, nullable=False)
    licensee_name      = Column(Text)
    business_name      = Column(Text)
    issue_date         = Column(Date)
    expiration_date    = Column(Date)
    status             = Column(Text)
    bond_amount        = Column(Numeric(12, 2))
    insurance_status   = Column(Text)
    discipline_history = Column(JSONB)
    source_url         = Column(Text)
    last_verified_at   = Column(DateTime(timezone=True))
    created_at         = Column(DateTime(timezone=True), default=func.now(), nullable=False)

    vendor = relationship("Vendor", back_populates="licenses")

    __table_args__ = (
        UniqueConstraint("state", "license_number", name="uq_vendor_licenses_state_number"),
    )


class VendorReviewSummary(Base):
    __tablename__ = "vendor_reviews_summary"

    review_summary_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id         = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id", ondelete="CASCADE"), nullable=False)
    source            = Column(Text, CheckConstraint("source IN ('google','yelp','angi','bbb')"), nullable=False)
    avg_rating        = Column(Numeric(3, 2))
    review_count      = Column(Integer)
    last_review_date  = Column(Date)
    sentiment_score   = Column(Numeric(4, 3))
    updated_at        = Column(DateTime(timezone=True), default=func.now(), nullable=False)

    vendor = relationship("Vendor", back_populates="review_summaries")

    __table_args__ = (
        UniqueConstraint("vendor_id", "source", name="uq_reviews_vendor_source"),
    )


class JobRun(Base):
    __tablename__ = "job_runs"

    run_id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_name         = Column(Text, nullable=False)
    run_type           = Column(Text, nullable=False)
    status             = Column(SAEnum(JobStatusEnum, name="job_status_enum"), default=JobStatusEnum.PENDING, nullable=False)
    started_at         = Column(DateTime(timezone=True))
    completed_at       = Column(DateTime(timezone=True))
    records_processed  = Column(Integer, default=0)
    records_created    = Column(Integer, default=0)
    records_updated    = Column(Integer, default=0)
    records_failed     = Column(Integer, default=0)
    records_skipped    = Column(Integer, default=0)
    error_log          = Column(JSONB)
    geo_scope          = Column(Text)
    category_scope     = Column(Text)
    triggered_by       = Column(Text)
    parent_run_id      = Column(UUID(as_uuid=True), ForeignKey("job_runs.run_id"), nullable=True)
    created_at         = Column(DateTime(timezone=True), default=func.now(), nullable=False)


class DedupPair(Base):
    __tablename__ = "dedup_pairs"

    pair_id       = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    vendor_id_a   = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id"), nullable=False)
    vendor_id_b   = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id"), nullable=False)
    match_score   = Column(Numeric(4, 3), nullable=False)
    match_signals = Column(JSONB, nullable=False)
    resolution    = Column(SAEnum(DedupResolutionEnum, name="dedup_resolution_enum"), default=DedupResolutionEnum.pending, nullable=False)
    resolved_at   = Column(DateTime(timezone=True))
    resolved_by   = Column(Text)
    canonical_id  = Column(UUID(as_uuid=True), ForeignKey("vendors.vendor_id"), nullable=True)
    created_at    = Column(DateTime(timezone=True), default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("vendor_id_a", "vendor_id_b", name="uq_dedup_pairs"),
    )
