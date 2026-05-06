import re
import httpx

# Reuse macro extraction helpers from barcode_service — same provider, same
# nutriments structure, no need to duplicate the logic.
from app.services.barcode_service import _get_macros, _nutrition_tier, _safe_float
from app.services.candidate_scorer import score_candidate
from app.services.debug_logger import log_off_candidates, log_rejection

# ---------------------------------------------------------------------------
# Open Food Facts text search API (v2)
# Same provider as barcode lookup; no API key required.
# Results are sorted by scan popularity so the most recognised product for
# a given name comes first.
# ---------------------------------------------------------------------------
OPENFOODFACTS_SEARCH_URL = "https://world.openfoodfacts.org/api/v2/search"
REQUEST_TIMEOUT          = 8.0
# Phase 1 increase: 15 candidates gives the scorer a deeper pool to rank,
# which matters most for popular branded queries where many variants exist
# (e.g. Hershey's has bars, kisses, miniatures, syrup, cocoa all in the top-10).
MAX_CANDIDATES           = 15

# Phase 3: minimum acceptable relevance score.  Below this the result is
# more likely to be the wrong product than the right one; let the router
# fall back to the nutrition engine instead.
MIN_SCORE = 10


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _parse_serving_grams(serving_size: str) -> float | None:
    """
    Try to extract a gram value from an OFF serving_size string.

    Handles common formats:
      "43 g"  "43g"  "1.55 oz"  "1.55oz"  "30 ml" (ml ≈ g for food density≈1)

    Returns None when the string is unparseable or the value is implausible.
    """
    s = serving_size.lower().strip()
    # Direct grams / ml
    m = re.search(r"([\d.]+)\s*(g|ml|gr)\b", s)
    if m:
        val = float(m.group(1))
        return val if 1 < val < 2000 else None
    # Ounces → grams
    m = re.search(r"([\d.]+)\s*oz\b", s)
    if m:
        val = float(m.group(1)) * 28.3495
        return val if 1 < val < 2000 else None
    return None


def _normalize_product(product: dict) -> dict | None:
    """
    Normalize a single OFF product dict into Lume's nutrition shape.
    Returns None if the product lacks a name or usable calorie data.

    When the OFF entry only provides per-100g nutrition (no per-serving values),
    and the product includes a parseable serving size in grams, the per-100g
    macros are scaled to that serving weight so calorie figures are per-item
    rather than per-100g.  This prevents, e.g., a Hershey bar (43g) from
    returning 490 cal (per-100g) instead of the correct ~211 cal per bar.
    """
    name = (
        product.get("product_name")
        or product.get("product_name_en")
        or ""
    ).strip()
    if not name:
        return None

    nutriments = product.get("nutriments", {})
    macros     = _get_macros(nutriments)
    if macros is None:
        return None

    calories, protein, carbs, fat = macros

    brand        = (product.get("brands")       or "").strip() or None
    serving_str  = (product.get("serving_size") or "").strip() or None

    # Scale per-100g macros to per-serving when the serving size is parseable.
    tier = _nutrition_tier(nutriments)
    if tier == "_100g" and serving_str:
        serving_g = _parse_serving_grams(serving_str)
        if serving_g:
            scale    = serving_g / 100.0
            calories = calories * scale
            protein  = protein  * scale
            carbs    = carbs    * scale
            fat      = fat      * scale

    return {
        "name":                name,
        "calories":            round(calories),
        "protein":             round(protein, 1),
        "carbs":               round(carbs, 1),
        "fat":                 round(fat, 1),
        "is_estimated":        False,
        "source_type":         "packaged_product",
        "source_name":         "Open Food Facts",
        "brand_name":          brand,
        "serving_description": serving_str,
    }


# ---------------------------------------------------------------------------
# Public function — called by query_router
# ---------------------------------------------------------------------------

def search_packaged_product(query: str) -> dict | None:
    """
    Search Open Food Facts by product name and return the highest-scoring
    usable result for the given query.

    Phase 3: all usable candidates in the pool are normalized and scored via
    candidate_scorer.score_candidate.  The best-scoring result is returned
    only if its score meets MIN_SCORE — below that threshold the product is
    likely irrelevant and the caller should fall back.

    Returns None if:
      - no products match the query
      - all candidates lack sufficient nutrition data or score below MIN_SCORE
      - the request fails for any reason

    The returned dict includes an `_internal_score` key that the router uses
    to map score → confidence tier.  The router must pop this key before
    returning to the caller.
    """
    try:
        response = httpx.get(
            OPENFOODFACTS_SEARCH_URL,
            params={
                "search_terms": query.strip(),
                "page_size":    MAX_CANDIDATES,
                "sort_by":      "unique_scans_n",
                # Request only the fields we actually use to keep response light
                "fields": "product_name,product_name_en,brands,serving_size,nutriments",
            },
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "Lume-App/1.0 (calorie tracker)"},
        )
        response.raise_for_status()
        products = response.json().get("products", [])

    except Exception:
        return None   # network / HTTP / parse failure — caller falls back

    best_result = None
    best_score  = MIN_SCORE - 1   # must beat this to be accepted
    scored_log: list[tuple[str, str | None, int]] = []   # for debug output

    for product in products:
        result = _normalize_product(product)
        if result is None:
            continue

        s = score_candidate(result["name"], result["brand_name"], query)
        scored_log.append((result["name"], result["brand_name"], s))
        if s > best_score:
            best_score  = s
            best_result = result

    # Debug: log every candidate and its score so poor choices are diagnosable.
    scored_log.sort(key=lambda t: t[2], reverse=True)
    log_off_candidates(query, scored_log)

    if best_result is None:
        log_rejection(query, "off_packaged_no_candidate_above_min",
                      {"min_score": MIN_SCORE, "n_candidates": len(scored_log)})
        return None   # no usable hit above the minimum threshold

    return {**best_result, "_internal_score": best_score}
