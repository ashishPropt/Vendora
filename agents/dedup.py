"""
agents/dedup.py  —  Agent 7: Deduplication Agent

Identifies and merges duplicate vendor records using multi-signal ensemble scoring.
Signal weights: phone(40%), name fuzzy(25%), address(20%), domain(15%), email(10%), zip bonus(5%)
Thresholds: auto-merge >= 0.92, merge >= 0.82, human review >= 0.70
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from rapidfuzz import fuzz
from sqlalchemy.orm import Session
from sqlalchemy import or_

from db.models import Vendor, VendorSource, DedupPair, DedupResolutionEnum, SourceNameEnum
from utils import normalize_phone_e164, normalize_business_name, generate_blocking_key, extract_domain

logger = logging.getLogger(__name__)

SIGNAL_WEIGHTS = {"exact_phone": 0.40, "name_fuzzy": 0.25, "address": 0.20,
                   "domain": 0.15, "email": 0.10, "zip_bonus": 0.05}
AUTO_MERGE_THRESHOLD = 0.92
MERGE_THRESHOLD      = 0.82
HUMAN_REVIEW_LOW     = 0.70

SOURCE_PRIORITY = [
    SourceNameEnum.google, SourceNameEnum.yelp, SourceNameEnum.angi,
    SourceNameEnum.state_license, SourceNameEnum.county_list, SourceNameEnum.manual,
]


class DedupAgent:
    """Agent 7 — Deduplication Agent."""

    def __init__(self, db: Session):
        self.db = db

    def _score_phone(self, a, b):
        norm_a = normalize_phone_e164(a.primary_phone or "")
        norm_b = normalize_phone_e164(b.primary_phone or "")
        if norm_a and norm_b and norm_a == norm_b: return 1.0
        sec_a = normalize_phone_e164(a.secondary_phone or "")
        sec_b = normalize_phone_e164(b.secondary_phone or "")
        if sec_a and sec_b and sec_a == sec_b: return 0.9
        if (norm_a and sec_b and norm_a == sec_b) or (sec_a and norm_b and sec_a == norm_b): return 0.85
        return 0.0

    def _score_name(self, a, b):
        norm_a = normalize_business_name(a.canonical_name)
        norm_b = normalize_business_name(b.canonical_name)
        if not norm_a or not norm_b: return 0.0
        ratio = fuzz.token_set_ratio(norm_a, norm_b) / 100.0
        return ratio if ratio >= 0.80 else 0.0

    def _score_address(self, a, b):
        if a.address_hash and b.address_hash and a.address_hash == b.address_hash: return 1.0
        addr_a = (a.usps_normalized_address or f"{a.street_address} {a.city} {a.state} {a.zip}").strip().lower()
        addr_b = (b.usps_normalized_address or f"{b.street_address} {b.city} {b.state} {b.zip}").strip().lower()
        if not addr_a or not addr_b: return 0.0
        ratio = fuzz.token_sort_ratio(addr_a, addr_b) / 100.0
        return ratio if ratio >= 0.85 else 0.0

    def _score_domain(self, a, b):
        dom_a = extract_domain(a.website_url or "")
        dom_b = extract_domain(b.website_url or "")
        return 1.0 if dom_a and dom_b and dom_a == dom_b else 0.0

    def _score_email(self, a, b):
        ea = (a.email or "").lower().strip()
        eb = (b.email or "").lower().strip()
        if ea and eb and ea == eb:
            domain = ea.split("@")[-1] if "@" in ea else ""
            if domain not in {"gmail.com", "yahoo.com", "hotmail.com", "outlook.com"}: return 1.0
        return 0.0

    def _zip_bonus(self, a, b):
        return 1.0 if a.zip and b.zip and a.zip[:5] == b.zip[:5] else 0.0

    def compute_ensemble_score(self, a: Vendor, b: Vendor) -> tuple[float, dict]:
        signals = {
            "exact_phone": self._score_phone(a, b), "name_fuzzy": self._score_name(a, b),
            "address": self._score_address(a, b), "domain": self._score_domain(a, b),
            "email": self._score_email(a, b), "zip_bonus": self._zip_bonus(a, b),
        }
        if a.place_id and a.place_id == b.place_id:
            return 1.0, {"auto_merge_reason": "place_id_exact", **signals}
        if a.yelp_business_id and a.yelp_business_id == b.yelp_business_id:
            return 1.0, {"auto_merge_reason": "yelp_id_exact", **signals}
        if signals["exact_phone"] >= 0.9:
            return signals["exact_phone"], {"auto_merge_reason": "phone_exact", **signals}
        score = sum(signals[k] * SIGNAL_WEIGHTS[k] for k in SIGNAL_WEIGHTS)
        return round(min(score, 1.0), 4), signals

    def find_candidates(self, vendor: Vendor) -> list[Vendor]:
        candidates = set()
        blocking_key = generate_blocking_key(vendor.canonical_name or "", vendor.zip or "")
        name_prefix = blocking_key[:5]
        zip_code = vendor.zip or ""
        name_matches = (self.db.query(Vendor)
            .filter(Vendor.vendor_id != vendor.vendor_id, Vendor.is_active == True, Vendor.zip == zip_code).all())
        for v in name_matches:
            if normalize_business_name(v.canonical_name or "")[:5] == name_prefix.replace("_", ""):
                candidates.add(v.vendor_id)
        if vendor.primary_phone:
            phone_matches = (self.db.query(Vendor)
                .filter(Vendor.vendor_id != vendor.vendor_id,
                        or_(Vendor.primary_phone == vendor.primary_phone,
                            Vendor.secondary_phone == vendor.primary_phone)).all())
            for v in phone_matches: candidates.add(v.vendor_id)
        if vendor.place_id:
            e = self.db.query(Vendor).filter(Vendor.vendor_id != vendor.vendor_id, Vendor.place_id == vendor.place_id).first()
            if e: candidates.add(e.vendor_id)
        if vendor.yelp_business_id:
            e = self.db.query(Vendor).filter(Vendor.vendor_id != vendor.vendor_id, Vendor.yelp_business_id == vendor.yelp_business_id).first()
            if e: candidates.add(e.vendor_id)
        return self.db.query(Vendor).filter(Vendor.vendor_id.in_(candidates)).all() if candidates else []

    def _get_source_priority(self, vendor: Vendor) -> int:
        sources = self.db.query(VendorSource).filter(VendorSource.vendor_id == vendor.vendor_id).all()
        if not sources: return len(SOURCE_PRIORITY)
        priorities = []
        for src in sources:
            try: priorities.append(SOURCE_PRIORITY.index(src.source_name))
            except ValueError: priorities.append(len(SOURCE_PRIORITY))
        return min(priorities)

    def merge_vendors(self, primary: Vendor, secondary: Vendor, match_score: float, signals: dict) -> Vendor:
        pri_a = self._get_source_priority(primary)
        pri_b = self._get_source_priority(secondary)
        canonical, duplicate = (primary, secondary) if pri_a <= pri_b else (secondary, primary)
        # Golden record field merge
        for field in ["primary_phone", "website_url", "email", "street_address", "years_in_business"]:
            if not getattr(canonical, field) and getattr(duplicate, field):
                setattr(canonical, field, getattr(duplicate, field))
        if not canonical.lat and duplicate.lat:
            canonical.lat, canonical.lng = duplicate.lat, duplicate.lng
        for flag_field in ["is_licensed", "is_insured", "is_background_checked"]:
            if getattr(duplicate, flag_field): setattr(canonical, flag_field, True)
        for id_field in ["place_id", "yelp_business_id", "angi_pro_id"]:
            if getattr(duplicate, id_field) and not getattr(canonical, id_field):
                setattr(canonical, id_field, getattr(duplicate, id_field))
        canonical.source_ids = sorted(set(canonical.source_ids or []) | set(duplicate.source_ids or []))
        canonical.secondary_category_codes = list(set(canonical.secondary_category_codes or []) | set(duplicate.secondary_category_codes or []))
        duplicate.is_active = False
        canonical.updated_at = datetime.now(timezone.utc)
        self.db.query(VendorSource).filter(VendorSource.vendor_id == duplicate.vendor_id).update(
            {"vendor_id": canonical.vendor_id, "is_merged": True, "merge_target_id": canonical.vendor_id})
        try:
            self.db.add(DedupPair(vendor_id_a=primary.vendor_id, vendor_id_b=secondary.vendor_id,
                match_score=match_score, match_signals=signals, resolution=DedupResolutionEnum.merged,
                resolved_at=datetime.now(timezone.utc), resolved_by="dedup_agent_v1", canonical_id=canonical.vendor_id))
        except Exception: pass
        self.db.flush()
        logger.info(f"Merged vendor {duplicate.vendor_id} -> {canonical.vendor_id} (score={match_score:.3f})")
        return canonical

    def process_vendor(self, vendor: Vendor) -> dict:
        candidates = self.find_candidates(vendor)
        best_score, best_match, best_signals = 0.0, None, {}
        for candidate in candidates:
            score, signals = self.compute_ensemble_score(vendor, candidate)
            if score > best_score:
                best_score, best_match, best_signals = score, candidate, signals
        if best_score >= MERGE_THRESHOLD and best_match:
            canonical = self.merge_vendors(vendor, best_match, best_score, best_signals)
            self.db.commit()
            return {"action": "merged", "canonical_id": str(canonical.vendor_id), "score": best_score, "candidates_checked": len(candidates)}
        elif best_score >= HUMAN_REVIEW_LOW and best_match:
            try:
                self.db.add(DedupPair(vendor_id_a=vendor.vendor_id, vendor_id_b=best_match.vendor_id,
                    match_score=best_score, match_signals=best_signals, resolution=DedupResolutionEnum.manual_review))
                self.db.commit()
            except Exception: self.db.rollback()
            return {"action": "queued_for_review", "candidate_id": str(best_match.vendor_id), "score": best_score, "candidates_checked": len(candidates)}
        return {"action": "no_duplicate", "score": best_score, "candidates_checked": len(candidates)}

    def run_batch(self, limit: int = 500) -> dict:
        vendors = (self.db.query(Vendor).filter(Vendor.is_active == True)
            .outerjoin(DedupPair, (DedupPair.vendor_id_a == Vendor.vendor_id) | (DedupPair.vendor_id_b == Vendor.vendor_id))
            .filter(DedupPair.pair_id == None).limit(limit).all())
        stats = {"merged": 0, "queued_review": 0, "no_duplicate": 0, "processed": len(vendors)}
        for vendor in vendors:
            result = self.process_vendor(vendor)
            action = result.get("action", "")
            if action == "merged": stats["merged"] += 1
            elif action == "queued_for_review": stats["queued_review"] += 1
            else: stats["no_duplicate"] += 1
        logger.info(f"Dedup batch complete: {stats}")
        return stats
