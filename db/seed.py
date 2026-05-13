"""
db/seed.py  —  Seed the database with taxonomy data and optional sample vendors
"""

import logging
from datetime import datetime, timezone, date

from sqlalchemy.orm import Session

from db.models import (
    CategoryTaxonomy, Vendor, VendorSource, VendorLicense,
    VendorReviewSummary, SourceNameEnum
)
from taxonomy import TAXONOMY_LEAF_NODES
from utils import generate_vendor_slug

logger = logging.getLogger(__name__)


def seed_taxonomy(db: Session) -> int:
    """Insert all taxonomy leaf nodes. Skip if already present."""
    inserted = 0
    for node in TAXONOMY_LEAF_NODES:
        exists = db.query(CategoryTaxonomy).filter(
            CategoryTaxonomy.category_code == node["code"]
        ).first()
        if not exists:
            db.add(CategoryTaxonomy(
                category_code=node["code"], parent_code=node["parent"],
                display_name=node["display_name"],
                yelp_aliases=node.get("yelp_aliases", []),
                google_place_types=node.get("google_place_types", []),
                keywords=node.get("keywords", []),
                priority=node["priority"], is_active=True,
            ))
            inserted += 1
    db.commit()
    logger.info(f"Taxonomy seeded: {inserted} new categories inserted.")
    return inserted


def seed_sample_vendors(db: Session) -> int:
    """
    Insert representative sample vendors covering all score tiers, multiple states, multiple categories.
    7 vendors: NJ/NY plumbing+electrical (Tier A), NJ plumbing (Tier B), NJ handyman (Tier C),
    TX HVAC (Tier A), CA roofing (Tier A), FL landscaping (Tier B).
    """
    SAMPLE_VENDORS = [
        {"canonical_name": "Monroe Plumbing Experts LLC", "primary_phone": "+17325551234",
         "website_url": "https://monroeplumbing.example.com", "street_address": "145 Applegarth Rd",
         "city": "Monroe Township", "state": "NJ", "zip": "08831", "lat": 40.3218, "lng": -74.4199,
         "primary_category_code": "PLB.GEN", "secondary_category_codes": ["PLB.WHR", "PLB.DRN"],
         "classification_confidence": 0.97, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 12,
         "bbb_accredited": True, "bbb_rating": "A+", "bbb_complaint_count": 0,
         "service_radius_miles": 30, "service_states": ["NJ", "NY"],
         "yelp_business_id": "monroe-plumbing-experts-llc", "source": "yelp",
         "reviews": [
             {"source": "google", "avg_rating": 4.8, "review_count": 142, "last_review_date": date(2026, 5, 8)},
             {"source": "yelp",   "avg_rating": 4.5, "review_count": 45,  "last_review_date": date(2026, 4, 22)},
         ],
         "license": {"state": "NJ", "license_type": "Home Improvement Contractor",
                     "license_number": "13VH12345678", "status": "ACTIVE",
                     "expiration_date": date(2027, 6, 30), "bond_amount": 100000.00, "insurance_status": "VERIFIED"}},
        {"canonical_name": "ProElectric Services Inc", "primary_phone": "+12125559876",
         "website_url": "https://proelectric.example.com", "street_address": "88 Atlantic Ave",
         "city": "Brooklyn", "state": "NY", "zip": "11201", "lat": 40.6928, "lng": -73.9903,
         "primary_category_code": "ELC.GEN", "secondary_category_codes": ["ELC.PNL", "ELC.EMR"],
         "classification_confidence": 0.95, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 8,
         "bbb_accredited": True, "bbb_rating": "A", "bbb_complaint_count": 1,
         "service_radius_miles": 25, "service_states": ["NY", "NJ"], "place_id": "ChIJsample001", "source": "google",
         "reviews": [
             {"source": "google", "avg_rating": 4.6, "review_count": 98, "last_review_date": date(2026, 5, 1)},
             {"source": "yelp",   "avg_rating": 4.3, "review_count": 32, "last_review_date": date(2026, 3, 15)},
         ],
         "license": {"state": "NY", "license_type": "Electrical", "license_number": "EL-0012345",
                     "status": "ACTIVE", "expiration_date": date(2026, 12, 31), "bond_amount": 50000.00}},
        {"canonical_name": "A&E Plumbing Solutions", "primary_phone": "+17325556789",
         "website_url": "https://aeplumbing.example.com", "street_address": "300 Route 18",
         "city": "East Brunswick", "state": "NJ", "zip": "08816", "lat": 40.4187, "lng": -74.4176,
         "primary_category_code": "PLB.GEN", "secondary_category_codes": ["PLB.DRN"],
         "classification_confidence": 0.91, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 7, "bbb_accredited": False,
         "service_radius_miles": 20, "yelp_business_id": "ae-plumbing-solutions-east-brunswick", "source": "yelp",
         "reviews": [{"source": "google", "avg_rating": 4.3, "review_count": 55, "last_review_date": date(2026, 4, 10)}],
         "license": {"state": "NJ", "license_type": "Home Improvement Contractor",
                     "license_number": "13VH98765432", "status": "ACTIVE", "expiration_date": date(2027, 3, 31)}},
        {"canonical_name": "Quick Fix Handyman", "primary_phone": "+17325550001",
         "city": "Piscataway", "state": "NJ", "zip": "08854", "lat": 40.5548, "lng": -74.4624,
         "primary_category_code": "HND.GEN", "classification_confidence": 0.78, "classification_method": "llm",
         "is_licensed": False, "is_insured": False, "years_in_business": 3, "source": "angi",
         "reviews": [{"source": "angi", "avg_rating": 3.8, "review_count": 15, "last_review_date": date(2026, 2, 1)}]},
        {"canonical_name": "Lone Star HVAC Services", "primary_phone": "+12145551111",
         "website_url": "https://lonestar-hvac.example.com", "street_address": "1200 Commerce St",
         "city": "Dallas", "state": "TX", "zip": "75201", "lat": 32.7831, "lng": -96.8067,
         "primary_category_code": "HVC.ACR", "secondary_category_codes": ["HVC.HEA", "HVC.MNT"],
         "classification_confidence": 0.94, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 15,
         "service_radius_miles": 50, "service_states": ["TX"], "place_id": "ChIJsample002", "source": "google",
         "reviews": [
             {"source": "google", "avg_rating": 4.7, "review_count": 203, "last_review_date": date(2026, 5, 5)},
             {"source": "yelp",   "avg_rating": 4.5, "review_count": 67,  "last_review_date": date(2026, 4, 28)},
         ],
         "license": {"state": "TX", "license_type": "HVAC", "license_number": "TACLA012345C",
                     "status": "ACTIVE", "expiration_date": date(2027, 8, 31)}},
        {"canonical_name": "SoCal Roofing Masters", "primary_phone": "+13105552222",
         "city": "Los Angeles", "state": "CA", "zip": "90001", "lat": 33.9731, "lng": -118.2479,
         "primary_category_code": "ROF.REP", "secondary_category_codes": ["ROF.RPL", "ROF.GUT"],
         "classification_confidence": 0.93, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 20,
         "bbb_accredited": True, "bbb_rating": "A+", "service_radius_miles": 40, "source": "google",
         "reviews": [{"source": "google", "avg_rating": 4.9, "review_count": 312, "last_review_date": date(2026, 5, 10)}]},
        {"canonical_name": "Sunshine Landscaping & Lawn Care", "primary_phone": "+14075553333",
         "city": "Orlando", "state": "FL", "zip": "32801", "lat": 28.5480, "lng": -81.3749,
         "primary_category_code": "LND.LAW", "secondary_category_codes": ["LND.TRE", "LND.IRR"],
         "classification_confidence": 0.89, "classification_method": "rule",
         "is_licensed": True, "is_insured": True, "years_in_business": 11,
         "service_radius_miles": 35, "source": "yelp", "yelp_business_id": "sunshine-landscaping-orlando",
         "reviews": [
             {"source": "yelp",   "avg_rating": 4.4, "review_count": 78,  "last_review_date": date(2026, 4, 20)},
             {"source": "google", "avg_rating": 4.5, "review_count": 133, "last_review_date": date(2026, 5, 2)},
         ]},
    ]

    inserted = 0
    for vdata in SAMPLE_VENDORS:
        existing = None
        if vdata.get("yelp_business_id"):
            existing = db.query(Vendor).filter(Vendor.yelp_business_id == vdata["yelp_business_id"]).first()
        if not existing and vdata.get("place_id"):
            existing = db.query(Vendor).filter(Vendor.place_id == vdata["place_id"]).first()
        if existing:
            continue

        slug = generate_vendor_slug(vdata["canonical_name"], vdata.get("city", ""), vdata.get("state", ""))
        base_slug, counter = slug, 1
        while db.query(Vendor).filter(Vendor.slug == slug).first():
            slug = f"{base_slug}-{counter}"; counter += 1

        vendor = Vendor(
            canonical_name=vdata["canonical_name"], slug=slug,
            primary_phone=vdata.get("primary_phone"), website_url=vdata.get("website_url"),
            street_address=vdata.get("street_address"), city=vdata.get("city"),
            state=vdata.get("state"), zip=vdata.get("zip"),
            lat=vdata.get("lat"), lng=vdata.get("lng"),
            place_id=vdata.get("place_id"), yelp_business_id=vdata.get("yelp_business_id"),
            primary_category_code=vdata["primary_category_code"],
            secondary_category_codes=vdata.get("secondary_category_codes", []),
            classification_confidence=vdata.get("classification_confidence"),
            classification_method=vdata.get("classification_method"),
            is_licensed=vdata.get("is_licensed", False), is_insured=vdata.get("is_insured", False),
            years_in_business=vdata.get("years_in_business"),
            bbb_accredited=vdata.get("bbb_accredited"), bbb_rating=vdata.get("bbb_rating"),
            bbb_complaint_count=vdata.get("bbb_complaint_count"),
            service_radius_miles=vdata.get("service_radius_miles"),
            service_states=vdata.get("service_states"),
            last_validated_at=datetime.now(timezone.utc), source_ids=[],
        )
        db.add(vendor)
        db.flush()

        source_enum = SourceNameEnum(vdata.get("source", "manual"))
        db.add(VendorSource(
            vendor_id=vendor.vendor_id, source_name=source_enum,
            external_id=vdata.get("yelp_business_id") or vdata.get("place_id"),
            raw_data={"seeded": True, "canonical_name": vdata["canonical_name"]},
        ))
        for rev in vdata.get("reviews", []):
            db.add(VendorReviewSummary(
                vendor_id=vendor.vendor_id, source=rev["source"],
                avg_rating=rev["avg_rating"], review_count=rev["review_count"],
                last_review_date=rev["last_review_date"],
            ))
        if vdata.get("license"):
            lic = vdata["license"]
            db.add(VendorLicense(
                vendor_id=vendor.vendor_id, state=lic["state"], license_type=lic["license_type"],
                license_number=lic["license_number"], status=lic["status"],
                expiration_date=lic.get("expiration_date"), bond_amount=lic.get("bond_amount"),
                insurance_status=lic.get("insurance_status"),
                last_verified_at=datetime.now(timezone.utc),
            ))
        inserted += 1

    db.commit()

    # Score all newly inserted vendors
    from db.connection import get_db as get_db_ctx
    from agents.scoring import ScoringAgent
    with get_db_ctx() as score_db:
        scorer = ScoringAgent(score_db)
        unscored = score_db.query(Vendor).filter(Vendor.vendor_score == None, Vendor.is_active == True).all()
        for v in unscored:
            scorer.score_vendor(v, trigger_event="seed")
        score_db.commit()

    logger.info(f"Sample vendors seeded: {inserted} inserted.")
    return inserted
