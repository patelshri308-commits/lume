import httpx

# Reuse macro extraction helpers from barcode_service — same provider, same
# nutriments structure, no need to duplicate the logic.
from app.services.barcode_service import _get_macros, _nutrition_tier, _safe_float, _parse_serving_grams, _parse_fl_oz_only
from app.services.candidate_scorer import score_candidate
from app.services.debug_logger import log_off_candidates, log_rejection

# ---------------------------------------------------------------------------
# Open Food Facts text search API (v2)
# Same provider as barcode lookup and packaged product search; no API key
# required.  Results are sorted by scan popularity so the most recognised
# product for a given name comes first.
# ---------------------------------------------------------------------------
OPENFOODFACTS_SEARCH_URL = "https://search.openfoodfacts.org/search"
REQUEST_TIMEOUT          = 8.0
# Phase 1 increase: 15 candidates gives the scorer a deeper pool to rank,
# especially important for chain restaurant queries where many regional
# variants of the same item may exist in the OFF database.
MAX_CANDIDATES           = 15

# Phase 3: minimum acceptable relevance score.  Restaurant queries tend to
# produce noisier OFF results than packaged products, so we keep the same
# floor but rely on the scorer's brand-token bonus to surface the right item.
MIN_SCORE = 10


# ---------------------------------------------------------------------------
# Serving-size helpers (OFF v3 does not return serving_size)
# ---------------------------------------------------------------------------

_OFF_SERVING_GRAMS: dict[str, float] = {
    "chipotle chicken bowl": 450.0,   # full meal-prep / restaurant bowl
    "chipotle bowl":         450.0,
    "frappuccino":           405.0,   # backup when fl-oz quantity not present
}


def _serving_grams_for_name(name: str) -> float | None:
    """Return a known per-serving gram weight for a product name, or None."""
    n = name.lower()
    best = max(
        ((k, v) for k, v in _OFF_SERVING_GRAMS.items() if k in n),
        key=lambda kv: len(kv[0]),
        default=None,
    )
    return best[1] if best else None


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

    _brands_raw = product.get("brands") or ""
    brand       = (", ".join(_brands_raw) if isinstance(_brands_raw, list) else _brands_raw).strip() or None
    serving_str = (product.get("serving_size") or "").strip() or None

    # C2 outlier guard: reject physically impossible entries before any scaling.
    # A single food item over 3,000 kcal is essentially never legitimate; the
    # known failure mode is a corrupt OFF bulk entry (e.g. 47,000 kcal) that
    # slips through scoring because the product name matches well.
    if calories > 3000:
        return None

    # Scale per-100g macros to per-serving using a three-level cascade:
    #   1. serving_size field from OFF response
    #   2. quantity field parsed as fl oz (single-serve beverages only)
    #   3. _OFF_SERVING_GRAMS keyword lookup (known restaurant/meal foods)
    tier = _nutrition_tier(nutriments)
    if tier == "_100g":
        serving_g = None
        if serving_str:
            serving_g = _parse_serving_grams(serving_str)
        if serving_g is None:
            qty_str = (product.get("quantity") or "").strip()
            if qty_str:
                serving_g = _parse_fl_oz_only(qty_str)
        if serving_g is None:
            serving_g = _serving_grams_for_name(name)
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
        "source_type":         "restaurant",
        "source_name":         "Open Food Facts",
        "brand_name":          brand,
        "serving_description": serving_str,
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
                "q":                  query.strip(),
                "page_size":          MAX_CANDIDATES,
                # C3: restrict to US-sold products so US restaurant queries
                # don't match identically-named UK supermarket entries.
                "countries_tags_en":  "en:united-states",
                # Request all fields we use (quantity added for fl-oz beverage path).
                "fields": "product_name,product_name_en,brands,serving_size,quantity,nutriments",
            },
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "Lume-App/1.0 (calorie tracker)"},
        )
        response.raise_for_status()
        products = response.json().get("hits", [])

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
        log_rejection(query, "off_restaurant_no_candidate_above_min",
                      {"min_score": MIN_SCORE, "n_candidates": len(scored_log)})
        return None   # no usable hit above the minimum threshold

    return {**best_result, "_internal_score": best_score}
