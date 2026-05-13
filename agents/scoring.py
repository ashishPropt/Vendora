"""
agents/scoring.py  —  Agent 10: Vendor Scoring Agent

Composite score formula:
  VendorScore = (Quality x 0.30) + (Compliance x 0.25) + (Reputation x 0.25)
              + (Activity x 0.10) + (Coverage x 0.10) - Decay

Tiers: A=80-100, B=60-79, C=40-59, D=20-39, F=0-19
Decay: -2 pts/month inactive, max -20 pts
"""

import logging
import math
from datetime import datetime, timezone, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from db.models import Vendor, VendorScore, VendorLicense, VendorReviewSummary
from config import settings

logger = logging.getLogger(__name__)

SCORE_WEIGHTS = {"quality": 0.30, "compliance": 0.25, "reputation": 0.25, "activity": 0.10, "coverage": 0.10}
DECAY_RATE_PER_MONTH = 2.0
MAX_DECAY = 20.0


def _tier_from_score(score: float) -> str:
    if score >= 80: return "A"
    elif score >= 60: return "B"
    elif score >= 40: return "C"
    elif score >= 20: return "D"
    return "F"


class ScoringAgent:
    """Agent 10 — Vendor Scoring Agent. Pure synchronous computation, <2s/vendor."""

    def __init__(self, db: Session, model_version: str = ""):
        self.db = db
        self.model_version = model_version or settings.SCORING_MODEL_VERSION

    def _compute_quality(self, vendor: Vendor, review_summaries) -> tuple[float, dict]:
        signals, total = {}, 0.0
        if review_summaries:
            total_weight = sum(max(r.review_count or 0, 1) for r in review_summaries)
            if total_weight > 0:
                weighted_avg = sum(float(r.avg_rating or 0) * max(r.review_count or 0, 1) for r in review_summaries) / total_weight
            else:
                weighted_avg = 0.0
            rating_pts = 25 if weighted_avg >= 4.5 else (15 if weighted_avg >= 4.0 else (5 if weighted_avg >= 3.0 else 0))
            signals["avg_rating"] = round(weighted_avg, 2)
            signals["avg_rating_pts"] = rating_pts
            total += rating_pts
            max_count = max((r.review_count or 0) for r in review_summaries)
            review_pts = 20 if max_count >= 50 else (10 if max_count >= 20 else 0)
            signals["review_count"] = max_count
            signals["review_count_pts"] = review_pts
            total += review_pts
        bbb_pts = 15 if vendor.bbb_accredited else 0
        bg_pts = 10 if vendor.is_background_checked else 0
        yib = vendor.years_in_business or 0
        yib_pts = 15 if yib >= 5 else (8 if yib >= 2 else 0)
        signals.update({"bbb_accreditation_pts": bbb_pts, "background_check_pts": bg_pts,
                        "years_in_business": yib, "years_in_business_pts": yib_pts})
        total += bbb_pts + bg_pts + yib_pts
        return round(min(total, 100.0), 2), signals

    def _compute_compliance(self, vendor: Vendor, licenses) -> tuple[float, dict]:
        signals, total = {}, 0.0
        today = datetime.now(timezone.utc).date()
        active_licenses = [lic for lic in licenses if lic.status == "ACTIVE"]
        if active_licenses:
            total += 40
            signals["active_license_pts"] = 40
            signals["license_count"] = len(active_licenses)
            not_expiring = [lic for lic in active_licenses if lic.expiration_date and (lic.expiration_date - today).days > 90]
            if not_expiring:
                total += 20
                signals["not_expiring_90d_pts"] = 20
            else:
                signals["not_expiring_90d_pts"] = 0
                flags = list(vendor.validation_flags or [])
                if "license_expiring_soon" not in flags:
                    vendor.validation_flags = flags + ["license_expiring_soon"]
        else:
            signals["active_license_pts"] = 0
            signals["not_expiring_90d_pts"] = 0
        if vendor.is_insured:
            total += 25
            signals["general_liability_pts"] = 25
        else:
            insured_via_license = any("verified" in (lic.insurance_status or "").lower() for lic in licenses if lic.insurance_status)
            if insured_via_license:
                total += 25
                vendor.is_insured = True
                signals["general_liability_pts"] = 25
            else:
                signals["general_liability_pts"] = 0
        workers_comp = any(lic.bond_amount and float(lic.bond_amount) > 0 for lic in licenses)
        if workers_comp:
            total += 15
            signals["workers_comp_pts"] = 15
        else:
            signals["workers_comp_pts"] = 0
        return round(min(total, 100.0), 2), signals

    def _compute_reputation(self, vendor: Vendor, reviews) -> tuple[float, dict]:
        signals, total = {}, 0.0
        source_weights = {"google": 0.50, "yelp": 0.30, "angi": 0.15, "bbb": 0.05}
        for source, weight in source_weights.items():
            review = next((r for r in reviews if r.source == source), None)
            if review and review.avg_rating and review.review_count:
                normalized = (float(review.avg_rating) / 5.0) * 100
                count_factor = min(math.log(max(review.review_count, 1) + 1) / math.log(201), 1.0)
                total += normalized * weight * count_factor
                signals[f"{source}_normalized"] = round(normalized, 1)
            else:
                signals[f"{source}_normalized"] = None
        sentiment_scores = [float(r.sentiment_score) for r in reviews if r.sentiment_score is not None]
        if sentiment_scores:
            avg_sentiment = sum(sentiment_scores) / len(sentiment_scores)
            total += (avg_sentiment + 1.0) / 2.0 * 100 * 0.05
            signals["avg_sentiment"] = round(avg_sentiment, 3)
        return round(min(total, 100.0), 2), signals

    def _compute_activity(self, vendor: Vendor, reviews) -> tuple[float, dict]:
        signals, total = {}, 0.0
        today = datetime.now(timezone.utc).date()
        review_dates = [r.last_review_date for r in reviews if r.last_review_date]
        if review_dates:
            last_review = max(review_dates)
            days_ago = (today - last_review).days
            review_pts = 40 if days_ago <= 90 else (20 if days_ago <= 180 else 0)
            signals["last_review_days_ago"] = days_ago
            signals["review_recency_pts"] = review_pts
            total += review_pts
        if vendor.website_url:
            total += 25
            signals["website_pts"] = 25
        if not vendor.validation_flags or "google_closed" not in vendor.validation_flags:
            total += 35
            signals["google_status_pts"] = 35
        else:
            signals["google_status_pts"] = 0
        return round(min(total, 100.0), 2), signals

    def _compute_coverage(self, vendor: Vendor) -> tuple[float, dict]:
        signals, total = {}, 0.0
        if vendor.service_radius_miles and vendor.service_radius_miles > 0:
            total += 30; signals["service_radius_pts"] = 30
        else:
            signals["service_radius_pts"] = 0
        secondary_count = len(vendor.secondary_category_codes or [])
        if secondary_count >= 2: total += 20; signals["multi_category_pts"] = 20
        else: signals["multi_category_pts"] = 0
        if len(vendor.service_states or []) >= 2: total += 25; signals["multi_state_pts"] = 25
        else: signals["multi_state_pts"] = 0
        emergency_cats = {"PLB.EMR", "ELC.EMR", "LCK.EMR", "HVC.ACR"}
        has_emergency = (vendor.primary_category_code in emergency_cats or
                         bool(set(vendor.secondary_category_codes or []) & emergency_cats))
        if has_emergency: total += 25; signals["emergency_pts"] = 25
        else: signals["emergency_pts"] = 0
        return round(min(total, 100.0), 2), signals

    def _compute_decay(self, vendor: Vendor) -> float:
        if not vendor.last_validated_at: return -MAX_DECAY
        delta = datetime.now(timezone.utc) - vendor.last_validated_at
        months_inactive = max(0, delta.days / 30.0 - 1)
        return -round(min(months_inactive * DECAY_RATE_PER_MONTH, MAX_DECAY), 2)

    def score_vendor(self, vendor: Vendor, trigger_event: str = "manual") -> VendorScore:
        licenses = self.db.query(VendorLicense).filter(VendorLicense.vendor_id == vendor.vendor_id).all()
        reviews = self.db.query(VendorReviewSummary).filter(VendorReviewSummary.vendor_id == vendor.vendor_id).all()
        quality, q_sig    = self._compute_quality(vendor, reviews)
        compliance, c_sig = self._compute_compliance(vendor, licenses)
        reputation, r_sig = self._compute_reputation(vendor, reviews)
        activity, a_sig   = self._compute_activity(vendor, reviews)
        coverage, cov_sig = self._compute_coverage(vendor)
        raw_score = (quality * SCORE_WEIGHTS["quality"] + compliance * SCORE_WEIGHTS["compliance"] +
                     reputation * SCORE_WEIGHTS["reputation"] + activity * SCORE_WEIGHTS["activity"] +
                     coverage * SCORE_WEIGHTS["coverage"])
        decay = self._compute_decay(vendor)
        final_score = round(max(0.0, min(100.0, raw_score + decay)), 2)
        tier = _tier_from_score(final_score)
        breakdown = {
            "quality_score": quality, "quality_signals": q_sig,
            "compliance_score": compliance, "compliance_signals": c_sig,
            "reputation_score": reputation, "reputation_signals": r_sig,
            "activity_score": activity, "activity_signals": a_sig,
            "coverage_score": coverage, "coverage_signals": cov_sig,
            "raw_score": round(raw_score, 2), "decay_adjustment": decay,
            "final_vendor_score": final_score, "score_tier": tier,
            "scored_by_model_version": self.model_version, "trigger_event": trigger_event,
        }
        score_row = VendorScore(
            vendor_id=vendor.vendor_id, vendor_score=final_score,
            quality_score=quality, compliance_score=compliance, reputation_score=reputation,
            activity_score=activity, coverage_score=coverage, score_tier=tier,
            score_breakdown=breakdown, scored_by_model_version=self.model_version,
            decay_adjustment=abs(decay), trigger_event=trigger_event,
        )
        self.db.add(score_row)
        vendor.vendor_score = final_score
        vendor.score_tier = tier
        vendor.last_scored_at = datetime.now(timezone.utc)
        logger.debug(f"Scored {vendor.vendor_id}: {vendor.canonical_name} -> {final_score:.2f} (tier {tier})")
        return score_row

    def run_batch(self, limit: int = 500, trigger_event: str = "batch_scheduled") -> dict:
        stale_threshold = datetime.now(timezone.utc) - timedelta(days=30)
        vendors = (self.db.query(Vendor)
            .filter(Vendor.is_active == True,
                    (Vendor.last_scored_at == None) | (Vendor.last_scored_at < stale_threshold))
            .limit(limit).all())
        stats = {"processed": len(vendors), "a": 0, "b": 0, "c": 0, "d": 0, "f": 0}
        for vendor in vendors:
            try:
                score_row = self.score_vendor(vendor, trigger_event=trigger_event)
                tier = (score_row.score_tier or "f").lower()
                if tier in stats: stats[tier] += 1
            except Exception as e:
                logger.error(f"Error scoring vendor {vendor.vendor_id}: {e}")
        self.db.commit()
        logger.info(f"Scoring batch complete: {stats}")
        return stats
