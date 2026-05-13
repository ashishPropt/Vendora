"""
agents/classification.py  —  Agent 8: Classification Agent

Three-layer classification:
  Layer 1: Rule-based lookup (Yelp alias -> code, Google type -> code)
  Layer 2: LLM (GPT-4o-mini) for ambiguous records
  Layer 3: Keyword fallback
"""

import json
import logging
from typing import Optional

from sqlalchemy.orm import Session

from db.models import Vendor
from taxonomy import TAXONOMY_LEAF_NODES, YELP_ALIAS_TO_CATEGORY, GOOGLE_TYPE_TO_CATEGORY
from config import settings

logger = logging.getLogger(__name__)

TAXONOMY_COMPACT = "\n".join(
    f"{n['code']} = {n['display_name']}"
    for n in TAXONOMY_LEAF_NODES
)

SYSTEM_PROMPT = f"""You are a property services vendor classification specialist for LeaseLoft.
Classify vendors into the LeaseLoft Vendor Taxonomy.

## TAXONOMY:
{TAXONOMY_COMPACT}

## FEW-SHOT EXAMPLES:
Example 1:
Input: {{"name": "Cool Breeze Services", "yelp_categories": ["hvac"], "description": "AC repair, refrigerator repair"}}
Output: {{"primary_category_code": "HVC.ACR", "secondary_category_codes": ["APP.REF"], "confidence": 0.88, "reasoning": "Primary is HVAC."}}

Example 2:
Input: {{"name": "ProFix Home Services", "yelp_categories": ["handyman","painters","flooring"]}}
Output: {{"primary_category_code": "HND.GEN", "secondary_category_codes": ["PNT.INT", "FLR.HRD"], "confidence": 0.85, "reasoning": "Handyman is broadest."}}

## OUTPUT FORMAT (strict JSON, no markdown):
{{"primary_category_code": "string", "secondary_category_codes": ["string"], "confidence": 0.0-1.0, "reasoning": "string"}}
"""


class ClassificationAgent:
    """
    Agent 8 — Classification Agent
    Classifies vendors via 3-layer cascade: rule -> LLM -> keyword fallback.
    """

    def __init__(self, db: Session, openai_api_key: str = ""):
        self.db = db
        self.openai_api_key = openai_api_key or settings.OPENAI_API_KEY
        self._openai_client = None

    def _get_openai_client(self):
        if not self._openai_client and self.openai_api_key:
            from openai import OpenAI
            self._openai_client = OpenAI(api_key=self.openai_api_key)
        return self._openai_client

    def _classify_rule_based(self, yelp_categories, google_primary_type, google_types):
        """Layer 1: Direct alias/type lookup."""
        for alias in (yelp_categories or []):
            code = YELP_ALIAS_TO_CATEGORY.get(alias)
            if code: return code, 1.0
        if google_primary_type:
            code = GOOGLE_TYPE_TO_CATEGORY.get(google_primary_type)
            if code: return code, 1.0
        for gtype in (google_types or []):
            code = GOOGLE_TYPE_TO_CATEGORY.get(gtype)
            if code: return code, 0.95
        return None, 0.0

    def _classify_llm(self, name, yelp_categories, google_primary_type, google_types, description=None, website_snippet=None):
        """Layer 2: GPT-4o-mini structured classification."""
        client = self._get_openai_client()
        if not client:
            return None, [], 0.0, "no_openai_key"
        user_content = json.dumps({
            "name": name, "yelp_categories": yelp_categories,
            "google_primary_type": google_primary_type, "google_types": google_types,
            "description": description or "",
            "website_text_snippet": (website_snippet or "")[:200],
        }, ensure_ascii=False)
        try:
            response = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": f"Classify:\n{user_content}"},
                ],
                max_tokens=300, temperature=0.1,
            )
            raw = response.choices[0].message.content or ""
            raw = raw.strip().strip("```json").strip("```").strip()
            result = json.loads(raw)
            return (
                result.get("primary_category_code"),
                result.get("secondary_category_codes", []),
                float(result.get("confidence", 0.0)),
                result.get("reasoning", ""),
            )
        except Exception as e:
            logger.error(f"LLM classification error: {e}")
            return None, [], 0.0, f"llm_error:{e}"

    def _classify_keyword_fallback(self, name: str, description: str = ""):
        """Layer 3: Keyword matching fallback."""
        text = f"{name} {description}".lower()
        best_code, best_hits = None, 0
        for node in TAXONOMY_LEAF_NODES:
            hits = sum(1 for kw in node.get("keywords", []) if kw.lower() in text)
            if hits > best_hits:
                best_hits = hits
                best_code = node["code"]
        if best_code and best_hits >= 2:
            confidence = min(0.65 + (best_hits * 0.03), 0.85)
            return best_code, confidence
        return None, 0.0

    def classify_vendor(self, vendor: Vendor, raw_source_data: Optional[dict] = None) -> dict:
        """Classify a vendor through the 3-layer cascade."""
        raw = raw_source_data or {}
        name = vendor.canonical_name or ""
        description = raw.get("description", raw.get("editorial_summary", ""))
        yelp_cats = []
        google_primary = None
        google_types = []
        if vendor.yelp_business_id:
            cats = raw.get("categories", [])
            yelp_cats = [c.get("alias", "") for c in cats if isinstance(c, dict)]
        if vendor.place_id:
            google_primary = raw.get("primaryType", "")
            google_types = raw.get("types", [])
        # Layer 1
        code, confidence = self._classify_rule_based(yelp_cats, google_primary, google_types)
        if code and confidence >= 0.95:
            vendor.primary_category_code = code
            vendor.classification_confidence = confidence
            vendor.classification_method = "rule"
            return {"method": "rule", "category_code": code, "confidence": confidence, "secondary": []}
        # Layer 2
        llm_primary, llm_secondary, llm_confidence, reasoning = self._classify_llm(
            name=name, yelp_categories=yelp_cats, google_primary_type=google_primary,
            google_types=google_types, description=description,
        )
        if llm_primary and llm_confidence >= 0.70:
            vendor.primary_category_code = llm_primary
            vendor.secondary_category_codes = llm_secondary
            vendor.classification_confidence = llm_confidence
            vendor.classification_method = "llm"
            return {"method": "llm", "category_code": llm_primary, "confidence": llm_confidence, "secondary": llm_secondary, "reasoning": reasoning}
        # Layer 3
        fallback_code, fallback_conf = self._classify_keyword_fallback(name, description)
        if fallback_code:
            vendor.primary_category_code = fallback_code
            vendor.classification_confidence = fallback_conf
            vendor.classification_method = "embedding"
            return {"method": "keyword_fallback", "category_code": fallback_code, "confidence": fallback_conf, "secondary": []}
        # Default
        vendor.primary_category_code = "HND.GEN"
        vendor.classification_confidence = 0.30
        vendor.classification_method = "manual"
        return {"method": "unclassified", "category_code": "HND.GEN", "confidence": 0.30, "secondary": []}

    def run_batch(self, limit: int = 200) -> dict:
        """Process unclassified vendors."""
        vendors = (
            self.db.query(Vendor)
            .filter(Vendor.is_active == True, Vendor.classification_confidence == None)
            .limit(limit).all()
        )
        stats = {"processed": len(vendors), "rule": 0, "llm": 0, "fallback": 0, "unclassified": 0}
        for vendor in vendors:
            result = self.classify_vendor(vendor)
            method = result.get("method", "unclassified")
            if method == "rule": stats["rule"] += 1
            elif method == "llm": stats["llm"] += 1
            elif "fallback" in method: stats["fallback"] += 1
            else: stats["unclassified"] += 1
        self.db.commit()
        logger.info(f"Classification batch complete: {stats}")
        return stats
