from app.services.nutrition_service import get_nutrition
from app.services.barcode_service import lookup_barcode, BarcodeNotFoundError, BarcodeProviderError
from app.services.packaged_product_service import search_packaged_product
from app.services.restaurant_service import search_restaurant_item


# ---------------------------------------------------------------------------
# Query classes
# ---------------------------------------------------------------------------

class QueryClass:
    BARCODE_LIKE          = "barcode_like"           # digit string, likely a barcode
    BRANDED_RESTAURANT    = "branded_restaurant"     # known chain/restaurant brand
    PACKAGED_PRODUCT      = "packaged_product"       # known packaged-food brand or product
    GENERIC_FOOD          = "generic_food"           # everything else (whole foods, meals, etc.)


# ---------------------------------------------------------------------------
# Classification signals
# ---------------------------------------------------------------------------

# Fast-food / chain restaurant brand words.
_RESTAURANT_SIGNALS = {
    "mcdonalds", "mcdonald",
    "chipotle",
    "starbucks",
    "burger king",
    "wendys", "wendy",
    "taco bell",
    "chick fil a", "chick-fil-a", "chickfila",
    "subway",
    "dominos", "domino",
    "kfc",
    "pizza hut",
    "panera",
    "dunkin",
    "popeyes",
    "sonic",
    "whataburger",
    "in-n-out", "in n out",
    "five guys",
    "shake shack",
    "panda express",
}

# Packaged / branded product names — distinct from restaurant brands.
_PACKAGED_SIGNALS = {
    "oreo",
    "quest",
    "clif", "rxbar", "larabar", "kind bar",
    "gatorade",
    "powerade",
    "red bull",
    "monster",
    "cheez it", "cheez-it",
    "doritos",
    "pringles",
    "lays",
    "nature valley",
    "nutella",
    "pop tart", "pop-tart",
    "twix", "snickers", "kit kat", "reese",
    "diet coke", "coke zero", "pepsi zero",
    "vitaminwater",
}


def _classify_query(query: str) -> str:
    """
    Classify a typed food query into one of the QueryClass buckets.

    Uses lightweight substring/keyword matching only — no ML, no external calls.
    Order of precedence: barcode → restaurant brand → packaged product → generic.
    """
    if _looks_like_barcode(query):
        return QueryClass.BARCODE_LIKE

    q = query.lower()

    for signal in _RESTAURANT_SIGNALS:
        if signal in q:
            return QueryClass.BRANDED_RESTAURANT

    for signal in _PACKAGED_SIGNALS:
        if signal in q:
            return QueryClass.PACKAGED_PRODUCT

    return QueryClass.GENERIC_FOOD


# ---------------------------------------------------------------------------
# Barcode detection helper
# ---------------------------------------------------------------------------

def _looks_like_barcode(query: str) -> bool:
    """Return True if the query is a string of 8–14 digits (EAN-8, EAN-13, UPC-A/E)."""
    s = query.strip()
    return s.isdigit() and 8 <= len(s) <= 14


# ---------------------------------------------------------------------------
# Public router
# ---------------------------------------------------------------------------


# Maps each QueryClass to the source_type string attached to the result.
_SOURCE_TYPE = {
    QueryClass.GENERIC_FOOD:       "generic",
    QueryClass.BRANDED_RESTAURANT: "restaurant_guess",
    QueryClass.PACKAGED_PRODUCT:   "packaged_guess",
}


def route_food_query(query: str) -> dict:
    """
    Route a typed food query to the best available source and stamp the
    result with a source_type field indicating which routing bucket was used.

    Current routing table
    ─────────────────────
    BARCODE_LIKE        → barcode_service (source_type="barcode", already set by service)
                          falls through to nutrition on miss (source_type="generic")
    BRANDED_RESTAURANT  → restaurant_service (source_type="restaurant", already set by service)
                          falls through to nutrition on miss (source_type="restaurant_guess")
    PACKAGED_PRODUCT    → packaged_product_service (source_type="packaged_product", already set)
                          falls through to nutrition on miss (source_type="packaged_guess")
    GENERIC_FOOD        → nutrition_service  source_type="generic"
    """
    query_class = _classify_query(query)

    if query_class == QueryClass.BARCODE_LIKE:
        try:
            return lookup_barcode(query)   # already carries source_type="barcode"
        except (BarcodeNotFoundError, BarcodeProviderError):
            pass   # miss or provider down — fall through as generic

    if query_class == QueryClass.BRANDED_RESTAURANT:
        result = search_restaurant_item(query)
        if result is not None:
            return result   # already carries source_type="restaurant"
        # miss or provider failure — fall through to nutrition engine below

    if query_class == QueryClass.PACKAGED_PRODUCT:
        result = search_packaged_product(query)
        if result is not None:
            return result   # already carries source_type="packaged_product"
        # miss or provider failure — fall through to nutrition engine below

    result = get_nutrition(query)
    # Barcode, restaurant, and packaged fall-throughs land here too; source_type
    # reflects that we ended up using the text/estimation engine.
    result["source_type"] = _SOURCE_TYPE.get(query_class, "generic")
    return result
