"""
Lume Food Engine — Phase 1 Query Router

Entry point for all typed food queries.  Parses the raw input, classifies
it, then dispatches to the appropriate source service in the order mandated
by the Phase 1 routing contract.

Routing contract (source priority per class)
────────────────────────────────────────────
BARCODE
  1. barcode_service
  → fail cleanly on miss — NEVER fall back to generic food

GENERIC_FOOD
  1. nutrition_service (USDA) — Phase 2: called with parsed.core_food + parsed.quantity
  → controlled estimate only if USDA misses

BRANDED_PACKAGED
  1. packaged_product_service (OFF text search)
  2. nutrition_service fallback (low-confidence)

RESTAURANT_ITEM
  1. restaurant_service (OFF text search)
  2. nutrition_service fallback (low-confidence)
  → never use generic food first when restaurant intent is clear

COMPOSITE_MEAL  [Phase 1: classify + preserve, conservative routing]
  1. nutrition_service with FULL query (including "with" components)
  → full decomposition deferred to a later phase

AMBIGUOUS  [Phase 1: classify + don't overconfidently guess]
  1. nutrition_service with full query
  → confidence capped to signal uncertainty

Confidence values
─────────────────
0.95  exact barcode hit
0.85  USDA match for GENERIC_FOOD

Packaged product (score-based, Phase 3):
0.88  score ≥ 55  — near-exact brand + all tokens present
0.75  score ≥ 30  — solid partial match
0.58  score ≥ 10  — weak but above threshold
0.35  score  < 10 / service miss — nutrition engine fallback

Restaurant item (score-based, Phase 3):
0.82  score ≥ 50  — chain brand + item tokens present
0.70  score ≥ 25  — solid partial match
0.55  score ≥ 10  — weak but above threshold
0.35  score  < 10 / service miss — nutrition engine fallback

Composite meal (decomposition-quality-based, Phase 4):
0.72  all components resolved via USDA, none estimated
0.55  all components resolved, ≥1 used rule-based fallback
0.42  partial decomposition — ≥1 component failed entirely
0.35  decomposition failed — single full-query estimate used

0.40  AMBIGUOUS query routed to nutrition engine
0.00  barcode not found (clean failure, no substitute data)

Note: size_modifier ("large", "small", "venti" …) is passed as a keyword
argument to get_nutrition on all paths that reach it via the router.  The
composite service forwards size_modifier to the first component only.
"""
from __future__ import annotations

from app.services.query_parser import parse as _parse
from app.services.query_classifier import classify as _classify, QueryClass
from app.services.nutrition_service import get_nutrition
from app.services.barcode_service import (
    lookup_barcode,
    BarcodeNotFoundError,
    BarcodeProviderError,
)
from app.services.packaged_product_service import search_packaged_product
from app.services.restaurant_service import search_restaurant_item
from app.services.composite_service import decompose_composite
from app.services.debug_logger import log_routing, log_rejection, log_result


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def route_food_query(query: str) -> dict:
    """
    Parse, classify, and route a typed food query.

    Always returns a dict matching the canonical nutrition shape:
      name, calories, protein, carbs, fat, is_estimated,
      source_type, brand_name, serving_description, confidence

    The `confidence` field (0.0–1.0) is set here based on source and class.
    It is an internal signal; the frontend ignores it for now and is unchanged.
    """
    parsed      = _parse(query)
    query_class = _classify(parsed)

    # Emit routing decision + parsed metadata for every request when debug is on.
    log_routing(query, query_class.value, {
        "quantity":        parsed.quantity,
        "unit":            parsed.unit,
        "size_modifier":   parsed.size_modifier,
        "with_components": parsed.with_components,
        "base_modifier":   parsed.base_modifier,
        "core_food":       parsed.core_food,
        "is_barcode":      parsed.is_barcode_like,
    })

    # ── BARCODE ──────────────────────────────────────────────────────────────
    # Contract: barcode source only.  A miss is a miss — no generic substitute.
    if query_class == QueryClass.BARCODE:
        try:
            result = lookup_barcode(parsed.clean)
            final  = {**result, "confidence": 0.95}
            log_result(query, "barcode", 0.95, final.get("calories", 0), final.get("name", ""))
            return final
        except (BarcodeNotFoundError, BarcodeProviderError):
            log_rejection(query, "barcode_not_found")
            return _barcode_not_found(parsed.raw)

    # ── BRANDED_PACKAGED ─────────────────────────────────────────────────────
    if query_class == QueryClass.BRANDED_PACKAGED:
        result = search_packaged_product(query)
        if result is not None:
            score = result.pop("_internal_score", 0)
            conf  = _packaged_confidence(score)
            final = {**result, "confidence": conf}
            log_result(query, "packaged_product", conf, final.get("calories", 0), final.get("name", ""))
            return final
        # Service miss — fall back to nutrition engine at low confidence.
        # Pass size_modifier so "large bag of X" scales correctly if OFF missed.
        log_rejection(query, "off_packaged_miss_fallback_to_usda")
        result = get_nutrition(query, size_modifier=parsed.size_modifier)
        final  = {**result, "source_type": "packaged_guess", "confidence": 0.35}
        log_result(query, "packaged_guess", 0.35, final.get("calories", 0), final.get("name", ""))
        return final

    # ── RESTAURANT_ITEM ──────────────────────────────────────────────────────
    # Contract: never use generic food FIRST when restaurant intent is clear.
    if query_class == QueryClass.RESTAURANT_ITEM:
        result = search_restaurant_item(query)
        if result is not None:
            score = result.pop("_internal_score", 0)
            conf  = _restaurant_confidence(score)
            final = {**result, "confidence": conf}
            log_result(query, "restaurant", conf, final.get("calories", 0), final.get("name", ""))
            return final
        # Service miss — generic estimate only as last resort, clearly labelled.
        # Pass size_modifier so "large fries" scales the fallback estimate.
        log_rejection(query, "off_restaurant_miss_fallback_to_usda")
        result = get_nutrition(query, size_modifier=parsed.size_modifier)
        final  = {**result, "source_type": "restaurant_guess", "confidence": 0.35}
        log_result(query, "restaurant_guess", 0.35, final.get("calories", 0), final.get("name", ""))
        return final

    # ── COMPOSITE_MEAL ───────────────────────────────────────────────────────
    # Phase 4: decompose into individual components, resolve each, aggregate.
    # The composite service handles "and"-splits, "with" add-ins, and
    # bread/base modifiers as described in composite_service.py.
    if query_class == QueryClass.COMPOSITE_MEAL:
        result = decompose_composite(parsed, query)
        meta   = result.pop("_decomposition_meta", {})
        conf   = _composite_confidence(meta)
        final  = {**result, "confidence": conf}
        log_result(query, "composite_meal", conf, final.get("calories", 0), final.get("name", ""))
        return final

    # ── AMBIGUOUS ────────────────────────────────────────────────────────────
    # Classify correctly; route but cap confidence to signal uncertainty.
    # Pass size_modifier so "small smoothie" returns a scaled estimate.
    if query_class == QueryClass.AMBIGUOUS:
        result = get_nutrition(query, size_modifier=parsed.size_modifier)
        final  = {**result, "source_type": "ambiguous_estimate", "confidence": 0.40}
        log_result(query, "ambiguous_estimate", 0.40, final.get("calories", 0), final.get("name", ""))
        return final

    # ── GENERIC_FOOD (default) ───────────────────────────────────────────────
    # Phase 2: use the parser's core_food as the USDA search term so that
    # "2 eggs" searches for "eggs", and "2.5 cups rice" searches for "rice".
    # Phase 4: also pass size_modifier so "large latte" scales the result.
    search_query = parsed.core_food if parsed.core_food else query
    result = get_nutrition(
        search_query,
        quantity=parsed.quantity,
        size_modifier=parsed.size_modifier,
    )
    # Display name: keep the full original input ("2 eggs", not just "eggs").
    result["name"] = parsed.clean
    confidence = 0.45 if result.get("is_estimated") else 0.85
    final = {
        **result,
        "source_type": result.get("source_type", "generic"),
        "confidence":  confidence,
    }
    log_result(query, final["source_type"], confidence, final.get("calories", 0), final.get("name", ""))
    return final


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _composite_confidence(meta: dict) -> float:
    """
    Map composite decomposition metadata to a confidence value.

    The composite service reports how many components were attempted, how many
    resolved successfully, and whether any used the rule-based fallback estimator.
    These three dimensions produce four quality tiers:

      all USDA, none estimated  → 0.72   strongest multi-component result
      all resolved, some est.   → 0.55   complete but some macros are estimates
      partial (some failed)     → 0.42   macros are a lower-bound — missing items
      all failed / no comps.    → 0.35   full-query fallback, single estimate
    """
    n_total    = meta.get("component_count", 0)
    n_resolved = meta.get("resolved_count",  0)
    n_failed   = meta.get("failed_count",    0)
    any_est    = meta.get("any_estimated",   True)

    if n_total == 0 or n_resolved == 0:
        return 0.35   # decomposition failed — single full-query estimate used
    if n_failed > 0:
        return 0.42   # partial — at least one component completely unresolved
    if any_est:
        return 0.55   # all resolved, but ≥1 component used rule-based fallback
    return 0.72       # all components resolved via USDA — highest composite tier


def _packaged_confidence(score: int) -> float:
    """
    Map a candidate_scorer score to a confidence value for BRANDED_PACKAGED
    results.

    Tiers are calibrated so that a perfect-coverage result (score ≥ 55) is
    treated almost as confidently as a barcode hit, while a borderline pass
    (score 10–29) is flagged as uncertain.
    """
    if score >= 55:
        return 0.88
    if score >= 30:
        return 0.75
    if score >= 10:
        return 0.58
    return 0.45   # should not be reached (service rejects scores < MIN_SCORE)


def _restaurant_confidence(score: int) -> float:
    """
    Map a candidate_scorer score to a confidence value for RESTAURANT_ITEM
    results.

    Restaurant OFF entries tend to be noisier than packaged-product entries
    (chain nutritional info is often community-submitted), so the ceiling is
    slightly lower than the packaged tier.
    """
    if score >= 50:
        return 0.82
    if score >= 25:
        return 0.70
    if score >= 10:
        return 0.55
    return 0.45   # should not be reached (service rejects scores < MIN_SCORE)


def _barcode_not_found(raw_query: str) -> dict:
    """
    Clean failure response for a BARCODE-class query that found no product.

    Returns a zeroed-out result with confidence=0.0 so callers can detect
    the miss without receiving silently wrong generic-food nutrition data.
    Calories/macros are explicitly zero — not estimated from another source.
    """
    return {
        "name":                raw_query.strip(),
        "calories":            0,
        "protein":             0.0,
        "carbs":               0.0,
        "fat":                 0.0,
        "is_estimated":        True,
        "source_type":         "barcode",
        "brand_name":          None,
        "serving_description": None,
        "confidence":          0.0,
    }
