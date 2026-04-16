import httpx

# Reuse macro extraction helpers from barcode_service — same provider, same
# nutriments structure, no need to duplicate the logic.
from app.services.barcode_service import _get_macros, _safe_float

# ---------------------------------------------------------------------------
# Open Food Facts text search API (v2)
# Same provider as barcode lookup and packaged product search; no API key
# required.  Results are sorted by scan popularity so the most recognised
# product for a given name comes first.
# ---------------------------------------------------------------------------
OPENFOODFACTS_SEARCH_URL = "https://world.openfoodfacts.org/api/v2/search"
REQUEST_TIMEOUT          = 8.0
MAX_CANDIDATES           = 5   # fetch a small pool; stop at first usable hit


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_plausible_match(product_name: str, query: str) -> bool:
    """
    Return True if at least one meaningful query word appears in the product
    name.  Guards against returning a wildly off-topic first result.
    Ignores short filler words (≤ 2 chars) such as "a", "of", "or".
    """
    name_lower = product_name.lower()
    meaningful = [w for w in query.lower().split() if len(w) > 2]
    # If every query word is short (edge case), accept without checking
    if not meaningful:
        return True
    return any(w in name_lower for w in meaningful)


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
        "brand_name":          brand,
        "serving_description": serving,
    }


# ---------------------------------------------------------------------------
# Public function — called by query_router
# ---------------------------------------------------------------------------

def search_restaurant_item(query: str) -> dict | None:
    """
    Search Open Food Facts by product name and return the best usable result
    for a restaurant / fast-food typed query.

    Candidates are sorted by scan popularity (most recognised product first).
    The first candidate that passes plausibility and has complete macro data
    is returned.  Returns None if:
      - no products match the query
      - all candidates lack sufficient nutrition data
      - the request fails for any reason
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

    for product in products:
        name = (
            product.get("product_name")
            or product.get("product_name_en")
            or ""
        ).strip()

        if not _is_plausible_match(name, query):
            continue

        result = _normalize_product(product)
        if result is not None:
            return result

    return None   # no usable hit in the candidate pool
