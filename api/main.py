"""
api/main.py  —  Vendora REST API

Endpoints:
  GET  /api/v1/vendors                — paginated list with filters
  GET  /api/v1/vendors/search         — full-text + geo search
  GET  /api/v1/vendors/{vendor_id}    — full vendor detail + score breakdown
  POST /api/v1/vendors/{vendor_id}/flag — flag for review
  GET  /api/v1/categories             — taxonomy tree
  GET  /api/v1/pipeline/status        — pipeline health + queue depths
  POST /api/v1/pipeline/trigger       — trigger a pipeline run
  GET  /health                        — health check
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, or_, desc
from sqlalchemy.orm import Session

from config import settings
from db.connection import get_db
from db.models import (
    Vendor, VendorScore, VendorLicense, VendorReviewSummary,
    JobRun, JobStatusEnum, DedupPair
)
from taxonomy import TAXONOMY_LEAF_NODES

logger = logging.getLogger(__name__)

app = FastAPI(
    title="Vendora — Vendor Acquisition Engine API",
    description="Nationwide vendor discovery and scoring platform",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


def get_db_session():
    with get_db() as db:
        yield db


class FlagRequest(BaseModel):
    reason: str
    description: Optional[str] = None
    user_id: Optional[str] = None
    severity: str = "medium"


class PipelineTriggerRequest(BaseModel):
    agent: str
    geo_scope: Optional[str] = None
    category_scope: Optional[str] = None
    priority: str = "normal"
    triggered_by: str = "api"


def _category_display(code: str) -> Optional[str]:
    for node in TAXONOMY_LEAF_NODES:
        if node["code"] == code: return node["display_name"]
    return code


def _vendor_to_list_item(vendor: Vendor, reviews: list) -> dict:
    total_reviews = sum(r.review_count or 0 for r in reviews)
    avg_ratings = [float(r.avg_rating) for r in reviews if r.avg_rating]
    avg_rating = round(sum(avg_ratings) / len(avg_ratings), 2) if avg_ratings else None
    return {
        "vendor_id": str(vendor.vendor_id), "canonical_name": vendor.canonical_name,
        "slug": vendor.slug, "primary_category_code": vendor.primary_category_code,
        "category_display_name": _category_display(vendor.primary_category_code),
        "score_tier": vendor.score_tier,
        "vendor_score": float(vendor.vendor_score) if vendor.vendor_score else None,
        "is_licensed": vendor.is_licensed, "is_insured": vendor.is_insured,
        "primary_phone": vendor.primary_phone, "website_url": vendor.website_url,
        "city": vendor.city, "state": vendor.state, "zip": vendor.zip,
        "lat": float(vendor.lat) if vendor.lat else None,
        "lng": float(vendor.lng) if vendor.lng else None,
        "years_in_business": vendor.years_in_business,
        "avg_rating": avg_rating, "total_review_count": total_reviews,
    }


@app.get("/api/v1/vendors")
async def list_vendors(
    category_code: Optional[str] = Query(None),
    state:         Optional[str] = Query(None),
    city:          Optional[str] = Query(None),
    zip:           Optional[str] = Query(None),
    lat:           Optional[float] = Query(None),
    lng:           Optional[float] = Query(None),
    radius_miles:  int = Query(25, ge=1, le=100),
    min_score:     Optional[float] = Query(None, ge=0, le=100),
    score_tier:    Optional[str] = Query(None),
    is_licensed:   Optional[bool] = Query(None),
    is_insured:    Optional[bool] = Query(None),
    sort_by:       str = Query("vendor_score"),
    page:          int = Query(1, ge=1),
    per_page:      int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
):
    import time; start = time.time()
    q = db.query(Vendor).filter(Vendor.is_active == True)
    if category_code: q = q.filter(Vendor.primary_category_code == category_code)
    if state: q = q.filter(Vendor.state == state.upper())
    if city: q = q.filter(Vendor.city.ilike(f"%{city}%"))
    if zip: q = q.filter(Vendor.zip == zip[:5])
    if min_score: q = q.filter(Vendor.vendor_score >= min_score)
    if score_tier:
        tiers = [t.strip().upper() for t in score_tier.split(",")]
        q = q.filter(Vendor.score_tier.in_(tiers))
    if is_licensed is not None: q = q.filter(Vendor.is_licensed == is_licensed)
    if is_insured is not None: q = q.filter(Vendor.is_insured == is_insured)
    if lat and lng:
        deg = radius_miles / 69.0
        q = q.filter(Vendor.lat.between(lat - deg, lat + deg), Vendor.lng.between(lng - deg, lng + deg))
    if sort_by == "years_in_business": q = q.order_by(desc(Vendor.years_in_business))
    else: q = q.order_by(desc(Vendor.vendor_score))
    total = q.count()
    total_pages = max(1, -(-total // per_page))
    vendors = q.offset((page - 1) * per_page).limit(per_page).all()
    vendor_ids = [v.vendor_id for v in vendors]
    reviews_map = {}
    if vendor_ids:
        for r in db.query(VendorReviewSummary).filter(VendorReviewSummary.vendor_id.in_(vendor_ids)).all():
            reviews_map.setdefault(r.vendor_id, []).append(r)
    elapsed_ms = round((time.time() - start) * 1000)
    return {
        "data": [_vendor_to_list_item(v, reviews_map.get(v.vendor_id, [])) for v in vendors],
        "pagination": {"page": page, "per_page": per_page, "total": total,
                       "total_pages": total_pages, "has_next": page < total_pages, "has_prev": page > 1},
        "meta": {"query_time_ms": elapsed_ms},
    }


@app.get("/api/v1/vendors/search")
async def search_vendors(
    q:           str = Query(..., min_length=1),
    lat:         Optional[float] = Query(None),
    lng:         Optional[float] = Query(None),
    radius_miles: int = Query(25),
    score_tier:  Optional[str] = Query(None),
    page:        int = Query(1, ge=1),
    per_page:    int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db_session),
):
    import time; start = time.time()
    tokens = [t.strip() for t in q.split() if len(t.strip()) >= 2]
    base_q = db.query(Vendor).filter(Vendor.is_active == True)
    if tokens:
        base_q = base_q.filter(or_(*[Vendor.canonical_name.ilike(f"%{t}%") for t in tokens]))
    if score_tier:
        base_q = base_q.filter(Vendor.score_tier.in_([t.strip().upper() for t in score_tier.split(",")]))
    if lat and lng:
        deg = radius_miles / 69.0
        base_q = base_q.filter(Vendor.lat.between(lat - deg, lat + deg), Vendor.lng.between(lng - deg, lng + deg))
    total_hits = base_q.count()
    vendors = base_q.order_by(desc(Vendor.vendor_score)).offset((page - 1) * per_page).limit(per_page).all()
    vendor_ids = [v.vendor_id for v in vendors]
    reviews_map = {}
    if vendor_ids:
        for r in db.query(VendorReviewSummary).filter(VendorReviewSummary.vendor_id.in_(vendor_ids)).all():
            reviews_map.setdefault(r.vendor_id, []).append(r)
    return {
        "data": [_vendor_to_list_item(v, reviews_map.get(v.vendor_id, [])) for v in vendors],
        "search_meta": {"query": q, "query_time_ms": round((time.time() - start) * 1000),
                        "total_hits": total_hits, "geo_center": {"lat": lat, "lng": lng} if lat else None},
        "pagination": {"page": page, "per_page": per_page, "total": total_hits,
                       "total_pages": max(1, -(-total_hits // per_page)),
                       "has_next": page * per_page < total_hits, "has_prev": page > 1},
    }


@app.get("/api/v1/vendors/{vendor_id}")
async def get_vendor(vendor_id: str, db: Session = Depends(get_db_session)):
    try: vid = uuid.UUID(vendor_id)
    except ValueError: raise HTTPException(status_code=400, detail="Invalid vendor_id UUID format")
    vendor = db.query(Vendor).filter(Vendor.vendor_id == vid).first()
    if not vendor: raise HTTPException(status_code=404, detail=f"Vendor {vendor_id} not found")
    licenses = db.query(VendorLicense).filter(VendorLicense.vendor_id == vid).all()
    reviews = db.query(VendorReviewSummary).filter(VendorReviewSummary.vendor_id == vid).all()
    latest_score = db.query(VendorScore).filter(VendorScore.vendor_id == vid).order_by(desc(VendorScore.score_date)).first()
    return {
        "vendor_id": str(vendor.vendor_id), "canonical_name": vendor.canonical_name,
        "slug": vendor.slug, "primary_phone": vendor.primary_phone,
        "secondary_phone": vendor.secondary_phone, "email": vendor.email,
        "website_url": vendor.website_url, "street_address": vendor.street_address,
        "city": vendor.city, "state": vendor.state, "zip": vendor.zip, "county": vendor.county,
        "lat": float(vendor.lat) if vendor.lat else None, "lng": float(vendor.lng) if vendor.lng else None,
        "primary_category_code": vendor.primary_category_code,
        "category_display_name": _category_display(vendor.primary_category_code),
        "secondary_category_codes": vendor.secondary_category_codes or [],
        "classification_confidence": float(vendor.classification_confidence) if vendor.classification_confidence else None,
        "classification_method": vendor.classification_method,
        "vendor_score": float(vendor.vendor_score) if vendor.vendor_score else None,
        "score_tier": vendor.score_tier,
        "last_scored_at": vendor.last_scored_at.isoformat() if vendor.last_scored_at else None,
        "score_breakdown": latest_score.score_breakdown if latest_score else None,
        "is_active": vendor.is_active, "is_claimed": vendor.is_claimed,
        "is_licensed": vendor.is_licensed, "is_insured": vendor.is_insured,
        "is_background_checked": vendor.is_background_checked,
        "validation_flags": vendor.validation_flags or [],
        "bbb_accredited": vendor.bbb_accredited, "bbb_rating": vendor.bbb_rating,
        "bbb_complaint_count": vendor.bbb_complaint_count,
        "years_in_business": vendor.years_in_business,
        "service_radius_miles": vendor.service_radius_miles,
        "service_states": vendor.service_states or [],
        "place_id": vendor.place_id, "yelp_business_id": vendor.yelp_business_id,
        "angi_pro_id": vendor.angi_pro_id, "source_ids": vendor.source_ids or [],
        "licenses": [
            {"license_id": str(lic.license_id), "state": lic.state, "license_type": lic.license_type,
             "license_number": lic.license_number, "status": lic.status,
             "expiration_date": lic.expiration_date.isoformat() if lic.expiration_date else None,
             "is_expired": lic.expiration_date < datetime.now(timezone.utc).date() if lic.expiration_date else None,
             "bond_amount": float(lic.bond_amount) if lic.bond_amount else None}
            for lic in licenses
        ],
        "review_summary": [
            {"source": r.source, "avg_rating": float(r.avg_rating) if r.avg_rating else None,
             "review_count": r.review_count,
             "last_review_date": r.last_review_date.isoformat() if r.last_review_date else None}
            for r in reviews
        ],
        "created_at": vendor.created_at.isoformat(), "updated_at": vendor.updated_at.isoformat(),
        "last_validated_at": vendor.last_validated_at.isoformat() if vendor.last_validated_at else None,
    }


@app.post("/api/v1/vendors/{vendor_id}/flag")
async def flag_vendor(vendor_id: str, body: FlagRequest, db: Session = Depends(get_db_session)):
    try: vid = uuid.UUID(vendor_id)
    except ValueError: raise HTTPException(status_code=400, detail="Invalid vendor_id UUID format")
    vendor = db.query(Vendor).filter(Vendor.vendor_id == vid).first()
    if not vendor: raise HTTPException(status_code=404, detail="Vendor not found")
    flags = list(vendor.validation_flags or [])
    flag_str = f"user_flag:{body.reason}"
    if flag_str not in flags: flags.append(flag_str)
    vendor.validation_flags = flags
    from agents.scoring import ScoringAgent
    ScoringAgent(db).score_vendor(vendor, trigger_event=f"user_flag:{body.reason}")
    db.commit()
    return JSONResponse(status_code=202, content={
        "flag_id": f"flg_{uuid.uuid4().hex[:8]}", "vendor_id": vendor_id,
        "status": "received", "validation_queued": True,
        "estimated_review_at": datetime.now(timezone.utc).replace(hour=2, minute=0, second=0).isoformat(),
    })


@app.get("/api/v1/categories")
async def get_categories():
    parent_map: dict[str, list] = {}
    for node in TAXONOMY_LEAF_NODES:
        parent_map.setdefault(node["parent"], []).append(
            {"category_code": node["code"], "display_name": node["display_name"], "priority": node["priority"]})
    parent_names = {
        "PLB": "Plumbing", "HVC": "HVAC", "ELC": "Electrical", "ROF": "Roofing",
        "LND": "Landscaping", "CLN": "Cleaning", "PST": "Pest Control",
        "GCT": "General Contractor", "PNT": "Painting", "FLR": "Flooring",
        "APP": "Appliance Repair", "LCK": "Locksmith", "POL": "Pool & Spa",
        "WND": "Windows & Doors", "HND": "Handyman", "JNK": "Junk Removal",
        "DMP": "Dumpster Rental", "MLD": "Mold Remediation", "WDM": "Water Damage", "FND": "Foundation Repair",
    }
    categories = [
        {"parent_code": parent, "parent_name": parent_names.get(parent, parent),
         "children": sorted(children, key=lambda x: x["priority"])}
        for parent, children in sorted(parent_map.items())
    ]
    return {"categories": categories, "total_leaf_nodes": len(TAXONOMY_LEAF_NODES)}


@app.get("/api/v1/pipeline/status")
async def pipeline_status(db: Session = Depends(get_db_session)):
    total_vendors = db.query(func.count(Vendor.vendor_id)).scalar()
    active_vendors = db.query(func.count(Vendor.vendor_id)).filter(Vendor.is_active == True).scalar()
    tier_counts = {tier: db.query(func.count(Vendor.vendor_id)).filter(
        Vendor.score_tier == tier, Vendor.is_active == True).scalar() for tier in ["A", "B", "C", "D", "F"]}
    pending_dedup = db.query(func.count(DedupPair.pair_id)).filter(DedupPair.resolution == "pending").scalar()
    recent_jobs = db.query(JobRun).order_by(desc(JobRun.started_at)).limit(20).all()
    agent_statuses = {}
    for job in recent_jobs:
        if job.agent_name not in agent_statuses:
            agent_statuses[job.agent_name] = job.status.value if job.status else "UNKNOWN"
    try:
        r = __import__('redis').from_url(settings.REDIS_URL, decode_responses=True)
        queue_depths = {stream: r.xlen(stream) for stream in
                        ["vendors:raw:google", "vendors:raw:yelp", "vendors:raw:angi"]}
    except Exception:
        queue_depths = {}
    return {"pipeline_status": {
        "total_vendors": total_vendors, "active_vendors": active_vendors,
        "vendors_by_tier": tier_counts, "dedup_stats": {"pending_pairs": pending_dedup},
        "agents": agent_statuses, "redis_queue_depth": queue_depths,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }}


@app.post("/api/v1/pipeline/trigger")
async def trigger_pipeline(body: PipelineTriggerRequest, db: Session = Depends(get_db_session)):
    run = JobRun(agent_name=body.agent, run_type="TRIGGERED", status=JobStatusEnum.PENDING,
                 geo_scope=body.geo_scope or "NATIONAL", category_scope=body.category_scope or "ALL",
                 triggered_by=body.triggered_by)
    db.add(run); db.commit(); db.refresh(run)
    return JSONResponse(status_code=202, content={
        "run_id": str(run.run_id), "agent": body.agent, "status": "PENDING",
        "estimated_start_in_seconds": 15,
        "message": f"Pipeline run queued: {body.agent}, scope={body.geo_scope or 'NATIONAL'}/{body.category_scope or 'ALL'}",
    })


@app.get("/health")
async def health():
    return {"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()}
