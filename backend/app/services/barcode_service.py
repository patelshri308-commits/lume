import httpx

# ---------------------------------------------------------------------------
# Open Food Facts API
# Free, no API key required. Database: ~3M packaged food products globally.
# Docs: https://world.openfoodfacts.org/data
# ---------------------------------------------------------------------------
OPENFOODFACTS_URL = "https://world.openfoodfacts.org/api/v0/product/{barcode}.json"
REQUEST_TIMEOUT   = 8.0


# ---------------------------------------------------------------------------
# Exceptions — raised instead of returning None so callers can distinguish
# "not in database" from "couldn't reach the database".
# ---------------------------------------------------------------------------

class BarcodeNotFoundError(Exception):
    """Product barcode was not found in the Open Food Facts database,
    or the product exists but lacks usable nutrition data."""

class BarcodeProviderError(Exception):
    """Network error, HTTP error, or unexpected response from Open Food Facts."""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _safe_float(value) -> float:
    """Convert a value to float, returning 0.0 on failure."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _get_macros(nutriments: dict) -> tuple | None:
    """
    Extract (calories, protein, carbs, fat) from an Open Food Facts
    nutriments dict.

    Strategy:
      1. Try per-serving kcal values (_serving suffix).
      2. Fall back to per-100g values (_100g suffix).
      3. Within each tier, convert kJ → kcal if kcal key is absent.
      4. Return None if no positive calorie figure is found — we never
         invent values.

    All four macros are pulled from the same tier so they stay consistent.
    """
    for suffix in ("_serving", "_100g"):
        cal_raw = nutriments.get(f"energy-kcal{suffix}")

        if cal_raw is not None:
            calories = _safe_float(cal_raw)
        else:
            # Some products only store energy in kJ
            kj = nutriments.get(f"energy{suffix}")
            if kj is None:
                continue
            calories = _safe_float(kj) / 4.184

        if calories <= 0:
            continue

        return (
            calories,
            _safe_float(nutriments.get(f"proteins{suffix}")),
            _safe_float(nutriments.get(f"carbohydrates{suffix}")),
            _safe_float(nutriments.get(f"fat{suffix}")),
        )

    return None


# ---------------------------------------------------------------------------
# Public function — called by the router
# ---------------------------------------------------------------------------

def lookup_barcode(barcode: str) -> dict:
    """
    Look up a packaged food by barcode using Open Food Facts.

    Returns a normalized nutrition dict on success.

    Raises:
      BarcodeNotFoundError  — product not in the database, or product exists
                              but lacks usable nutrition data.
      BarcodeProviderError  — network error, HTTP error, or unexpected
                              upstream response.
    """
    try:
        response = httpx.get(
            OPENFOODFACTS_URL.format(barcode=barcode.strip()),
            timeout=REQUEST_TIMEOUT,
            headers={"User-Agent": "Lume-App/1.0 (calorie tracker)"},
        )
        response.raise_for_status()
        data = response.json()

    except BarcodeNotFoundError:
        raise   # should not occur here, but guard against re-entry
    except Exception as exc:
        raise BarcodeProviderError(f"Upstream request failed: {exc}") from exc

    # status == 1 means the product exists in the database
    if data.get("status") != 1:
        raise BarcodeNotFoundError(barcode)

    product    = data.get("product", {})
    nutriments = product.get("nutriments", {})
    macros     = _get_macros(nutriments)

    if macros is None:
        raise BarcodeNotFoundError(barcode)   # product found but data unusable

    calories, protein, carbs, fat = macros

    name = (
        product.get("product_name")
        or product.get("product_name_en")
        or "Unknown Product"
    ).strip()

    brand   = (product.get("brands")       or "").strip() or None
    serving = (product.get("serving_size") or "").strip() or None

    return {
        "name":                name,
        "calories":            round(calories),
        "protein":             round(protein, 1),
        "carbs":               round(carbs, 1),
        "fat":                 round(fat, 1),
        "is_estimated":        False,
        "source_type":         "barcode",
        "barcode":             barcode.strip(),
        "brand_name":          brand,
        "serving_description": serving,
    }
