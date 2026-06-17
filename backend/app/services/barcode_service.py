import httpx
from collections import OrderedDict

# ---------------------------------------------------------------------------
# Open Food Facts API
# Free, no API key required. Database: ~3M packaged food products globally.
# Docs: https://world.openfoodfacts.org/data
# ---------------------------------------------------------------------------
OPENFOODFACTS_URL = "https://world.openfoodfacts.org/api/v0/product/{barcode}.json"
REQUEST_TIMEOUT   = 8.0

# Simple in-memory LRU cache for barcode lookups.
# Only successful results are cached — errors are never stored so a transient
# network failure doesn't permanently poison a barcode in the same process.
_BARCODE_CACHE: OrderedDict = OrderedDict()
_CACHE_MAX_SIZE = 200


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
# Phase 2: serving-tier detection
# ---------------------------------------------------------------------------

def _parse_serving_grams(serving_size: str) -> float | None:
    """
    Extract a gram weight from an OFF serving_size string.

    Handles common formats: "43 g", "43g", "1.55 oz", "30 ml", "13.7 fl oz".
    Returns None when unparseable or the value is implausible (< 1g or > 2000g).
    """
    import re as _re
    s = serving_size.lower().strip()
    # Direct grams / ml (treat ml as g — water-density approximation)
    m = _re.search(r"([\d.]+)\s*(g|ml|gr)\b", s)
    if m:
        val = float(m.group(1))
        return val if 1 < val < 2000 else None
    # Fluid ounces → ml (must precede plain-oz check)
    m = _re.search(r"([\d.]+)\s*fl\.?\s*oz\b", s)
    if m:
        val = float(m.group(1)) * 29.5735
        return val if 1 < val < 2000 else None
    # Solid ounces → grams
    m = _re.search(r"([\d.]+)\s*oz\b", s)
    if m:
        val = float(m.group(1)) * 28.3495
        return val if 1 < val < 2000 else None
    return None


def _parse_fl_oz_only(s: str) -> float | None:
    """Return grams ONLY for fl-oz strings (beverages). Capped at 700 ml."""
    import re as _re
    m = _re.search(r"([\d.]+)\s*fl\.?\s*oz\b", s.lower())
    if m:
        val = float(m.group(1)) * 29.5735
        return val if 1 < val <= 700 else None
    return None


def _clean_brand(raw: str) -> str:
    """
    Normalize a raw Open Food Facts brand string.

    OFF stores brands as a comma-separated list (e.g. "Hershey's,Hershey").
    We take only the first entry, strip surrounding whitespace, and convert
    fully-uppercase names to title case so they read naturally in the UI.
    """
    primary = raw.split(",")[0].strip()
    if primary == primary.upper() and len(primary) > 1:
        primary = primary.title()
    return primary


def _nutrition_tier(nutriments: dict) -> str:
    """
    Return '_serving' if per-serving calorie data is present and positive,
    otherwise '_100g'.

    Mirrors the tier-selection logic in _get_macros so callers can determine
    which tier was actually used without having to re-parse the nutriments dict.
    This drives correct serving_description labelling: when only per-100g data
    is available, the response must say so explicitly rather than leaving
    serving_description=None (which the consumer would misinterpret as
    "per serving, serving size unknown").
    """
    for suffix in ("_serving", "_100g"):
        cal_raw = nutriments.get(f"energy-kcal{suffix}")
        if cal_raw is not None:
            if _safe_float(cal_raw) > 0:
                return suffix
        else:
            kj = nutriments.get(f"energy{suffix}")
            if kj is not None and _safe_float(kj) / 4.184 > 0:
                return suffix
    return "_100g"  # fallback assumption when neither tier has positive cal data


# ---------------------------------------------------------------------------
# Public function — called by the router
# ---------------------------------------------------------------------------

def lookup_barcode(barcode: str) -> dict:
    """
    Look up a packaged food by barcode using Open Food Facts.

    Returns a normalized nutrition dict on success.  Successful results are
    stored in an in-process LRU cache so repeated scans of the same product
    skip the network round-trip.

    Raises:
      BarcodeNotFoundError  — product not in the database, or product exists
                              but lacks usable nutrition data.
      BarcodeProviderError  — network error, HTTP error, or unexpected
                              upstream response.
    """
    code = barcode.strip()

    # Check cache before hitting the network.
    if code in _BARCODE_CACHE:
        _BARCODE_CACHE.move_to_end(code)
        return dict(_BARCODE_CACHE[code])

    try:
        response = httpx.get(
            OPENFOODFACTS_URL.format(barcode=code),
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
        raise BarcodeNotFoundError(code)

    product    = data.get("product", {})
    nutriments = product.get("nutriments", {})
    macros     = _get_macros(nutriments)

    if macros is None:
        raise BarcodeNotFoundError(code)   # product found but data unusable

    calories, protein, carbs, fat = macros

    name = (
        product.get("product_name")
        or product.get("product_name_en")
        or "Unknown Product"
    ).strip()

    raw_brand        = (product.get("brands")       or "").strip()
    brand            = _clean_brand(raw_brand) if raw_brand else None
    provided_serving = (product.get("serving_size") or "").strip() or None

    # Determine which data tier _get_macros actually used, and make the
    # serving context explicit so consumers are never misled.
    #
    #   _serving tier → label is the product's stated serving size (e.g. "30g")
    #   _100g    tier → per-serving data absent; label says "per 100g"
    tier = _nutrition_tier(nutriments)
    if tier == "_100g":
        if provided_serving:
            serving_description = f"{provided_serving} (per 100g)"
        else:
            serving_description = "per 100g"
    else:
        serving_description = provided_serving

    result = {
        "name":                name,
        "calories":            round(calories),
        "protein":             round(protein, 1),
        "carbs":               round(carbs, 1),
        "fat":                 round(fat, 1),
        "is_estimated":        False,
        "source_type":         "barcode",
        "source_name":         "Open Food Facts",
        "barcode":             code,
        "brand_name":          brand,
        "serving_description": serving_description,
        "confidence":          0.95,
    }

    # Store in cache; evict oldest entry when at capacity.
    _BARCODE_CACHE[code] = result
    _BARCODE_CACHE.move_to_end(code)
    if len(_BARCODE_CACHE) > _CACHE_MAX_SIZE:
        _BARCODE_CACHE.popitem(last=False)

    return dict(result)
