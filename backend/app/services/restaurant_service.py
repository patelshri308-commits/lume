import httpx

# Reuse macro extraction helpers from barcode_service — same provider, same
# nutriments structure, no need to duplicate the logic.
from app.services.barcode_service import _get_macros, _safe_float
from app.services.candidate_scorer import score_candidate

# ---------------------------------------------------------------------------
# Open Food Facts text search API (v2)
# Same provider as barcode lookup and packaged product search; no API key
# required.  Results are sorted by scan popularity so the most recognised
# product for a given name comes first.
# ---------------------------------------------------------------------------
OPENFOODFACTS_SEARCH_URL = "https://world.openfoodfacts.org/api/v2/search"
REQUEST_TIMEOUT          = 8.0
MAX_CANDIDATES           = 10   # wider pool so the scorer has real options

# Phase 3: minimum acceptable relevance score.  Restaurant queries tend to
# produce noisier OFF results than packaged products, so we keep the same
# floor but rely on the scorer's brand-token bonus to surface the right item.
MIN_SCORE = 10


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _normalize_product(product: dict) -> dict | None:
    """
    Normalize a single OFF product dict into Lume's nutrition shape.
    Returns None if the product lacks a name or usable calorie data.
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

    brand   = (product.get("brands")       or "").strip() or None
    serving = (product.get("serving_size") or "").strip() or None

    return {
        "name":                name,
        "calories":            round(calories),
        "protein":             round(protein, 1),
        "carbs":               round(carbs, 1),
        "fat":                 round(fat, 1),
        "is_estimated":        False,
        "source_type":         "restaurant",
        "source_name":         "Open Food Facts",
        "brand_name":          brand,
        "serving_description": serving,
    }


# ---------------------------------------------------------------------------
# Public function — called by query_router
# ---------------------------------------------------------------------------

def search_restaurant_item(query: str) -> dict | None:
    """
    Search Open Food Facts by product name and return the highest-scoring
    usable result for a restaurant / fast-food typed query.

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

    for product in products:
        result = _normalize_product(product)
        if result is None:
            continue

        s = score_candidate(result["name"], result["brand_name"], query)
        if s > best_score:
            best_score  = s
            best_result = result

    if best_result is None:
        return None   # no usable hit above the minimum threshold

    return {**best_result, "_internal_score": best_score}
