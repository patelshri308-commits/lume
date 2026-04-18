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
0.75  packaged product text match
0.70  restaurant item text match
0.45  USDA / fallback match for COMPOSITE_MEAL or AMBIGUOUS
0.35  nutrition engine fallback for a branded/restaurant miss
0.00  barcode not found (clean failure, no substitute data)
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

    # ── BARCODE ──────────────────────────────────────────────────────────────
    # Contract: barcode source only.  A miss is a miss — no generic substitute.
    if query_class == QueryClass.BARCODE:
        try:
            result = lookup_barcode(parsed.clean)
            return {**result, "confidence": 0.95}
        except (BarcodeNotFoundError, BarcodeProviderError):
            return _barcode_not_found(parsed.raw)

    # ── BRANDED_PACKAGED ─────────────────────────────────────────────────────
    if query_class == QueryClass.BRANDED_PACKAGED:
        result = search_packaged_product(query)
        if result is not None:
            return {**result, "confidence": 0.75}
        # Service miss — fall back to nutrition engine at low confidence
        result = get_nutrition(query)
        return {**result, "source_type": "packaged_guess", "confidence": 0.35}

    # ── RESTAURANT_ITEM ──────────────────────────────────────────────────────
    # Contract: never use generic food FIRST when restaurant intent is clear.
    if query_class == QueryClass.RESTAURANT_ITEM:
        result = search_restaurant_item(query)
        if result is not None:
            return {**result, "confidence": 0.70}
        # Service miss — generic estimate only as last resort, clearly labelled
        result = get_nutrition(query)
        return {**result, "source_type": "restaurant_guess", "confidence": 0.35}

    # ── COMPOSITE_MEAL ───────────────────────────────────────────────────────
    # Phase 1: classify and preserve the full query; route conservatively.
    # The FULL query (including "with" components) is passed so nothing is
    # silently discarded.  Full decomposition is deferred to a later phase.
    if query_class == QueryClass.COMPOSITE_MEAL:
        result = get_nutrition(query)   # passes "coffee with milk", not "coffee"
        return {**result, "source_type": "composite_estimate", "confidence": 0.45}

    # ── AMBIGUOUS ────────────────────────────────────────────────────────────
    # Phase 1: classify correctly; route but cap confidence to signal uncertainty.
    if query_class == QueryClass.AMBIGUOUS:
        result = get_nutrition(query)
        return {**result, "source_type": "ambiguous_estimate", "confidence": 0.40}

    # ── GENERIC_FOOD (default) ───────────────────────────────────────────────
    # Phase 2: use the Phase 1 parser's core_food as the USDA search term so
    # that "2 eggs" searches for "eggs" (not "2 eggs"), and "2.5 cups rice"
    # searches for "rice" (not "2.5 cups rice").  Pass parsed.quantity so the
    # nutrition service can scale by the exact parsed value — including decimals
    # and number words that the legacy integer extractor cannot handle.
    search_query = parsed.core_food if parsed.core_food else query
    result = get_nutrition(search_query, quantity=parsed.quantity)
    # Display name: keep the full original input ("2 eggs", not just "eggs").
    result["name"] = parsed.clean
    confidence = 0.45 if result.get("is_estimated") else 0.85
    return {
        **result,
        "source_type": result.get("source_type", "generic"),
        "confidence":  confidence,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

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
