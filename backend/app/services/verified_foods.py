"""
Verified common-food registry for Lume.

Each entry stores audited per-100g nutrition values for a specific USDA source.
Verified entries bypass the live USDA search path entirely — they are looked up
from a static dict whose keys match the output of _normalize_query().

When a query hits a verified entry, _fetch_nutrition returns the pinned
nutrition without any network call.  This makes common whole-food queries
faster, deterministic, and immune to USDA search-index drift.

Per-100g values were pinned from audit runs on 2026-06-03 and back-calculated
from the observed total-calorie output:

    per_100g = audit_total_calories / (profile.default_grams / 100)

To refresh a value, run the audit harness.  If the live result drifts outside
the audit range, update the entry and re-run the full test suite.

Phase 8B pilot: banana, egg/eggs, white rice, olive oil, chicken breast.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class VerifiedFoodEntry:
    # Nutrition per 100 g — same convention as USDA FoodData Central.
    # get_nutrition() applies a grams/100 scale factor identical to the USDA path.
    calories_per_100g: float
    protein_per_100g:  float
    carbs_per_100g:    float
    fat_per_100g:      float

    # Source metadata returned verbatim in the nutrition response dict.
    source_name: str
    source_type: str   = "verified_generic"

    # confidence=1.0 is returned by get_nutrition() on direct calls.
    # query_router.py overwrites confidence for GENERIC_FOOD paths (0.85 for
    # any non-estimated result), so this value is visible only on direct
    # get_nutrition() / _fetch_nutrition() calls, not through the router.
    confidence:  float = 1.0

    # Serving defaults — same field names as GenericFoodProfile so that
    # get_nutrition()'s scaling block duck-types across both.
    default_grams: float = 100.0
    unit_grams:    dict[str, float] = field(default_factory=dict)


# Keys must match _normalize_query() output — lowercase, stripped of leading
# digits, leading number-words, size modifiers, and filler articles.
# Examples: "2 eggs" → "eggs"; the router passes core_food="olive oil" for
# "1 tbsp olive oil", so the key is "olive oil".
#
# Per-100g values were pinned from audit runs on 2026-06-03.
_VERIFIED_FOODS: dict[str, VerifiedFoodEntry] = {
    # ── Fruits ───────────────────────────────────────────────────────────────
    # 85.0 kcal/100g × 118g default = 100.3 kcal (matches audit)
    "banana": VerifiedFoodEntry(
        calories_per_100g=85.0,
        protein_per_100g=1.1,
        carbs_per_100g=22.8,
        fat_per_100g=0.3,
        source_name="Bananas, overripe, raw",
        default_grams=118,
        unit_grams={"large": 136, "small": 101},
    ),

    # ── Proteins ─────────────────────────────────────────────────────────────
    # 148.0 kcal/100g × 50g/egg × 2 eggs = 148.0 kcal (scale=1.0, matches audit)
    "egg": VerifiedFoodEntry(
        calories_per_100g=148.0,
        protein_per_100g=12.6,
        carbs_per_100g=0.7,
        fat_per_100g=10.6,
        source_name="Eggs, Grade A, Large, egg whole",
        default_grams=50,
    ),
    "eggs": VerifiedFoodEntry(
        calories_per_100g=148.0,
        protein_per_100g=12.6,
        carbs_per_100g=0.7,
        fat_per_100g=10.6,
        source_name="Eggs, Grade A, Large, egg whole",
        default_grams=50,
    ),
    # 165.0 kcal/100g × 100g default = 165.0 kcal (matches audit)
    "chicken breast": VerifiedFoodEntry(
        calories_per_100g=165.0,
        protein_per_100g=31.0,
        carbs_per_100g=0.0,
        fat_per_100g=3.6,
        source_name="Chicken, broilers or fryers, breast, meat only, cooked, roasted",
        default_grams=100,
    ),

    # ── Grains ───────────────────────────────────────────────────────────────
    # 130.0 kcal/100g × 158g default = 205.4 kcal (matches audit)
    "white rice": VerifiedFoodEntry(
        calories_per_100g=130.0,
        protein_per_100g=2.7,
        carbs_per_100g=28.2,
        fat_per_100g=0.3,
        source_name="Rice, white, cooked, as ingredient",
        default_grams=158,
        unit_grams={"cup": 158, "cups": 158},
    ),

    # ── Oils ─────────────────────────────────────────────────────────────────
    # 884.0 kcal/100g × 13.5g (1 tbsp) / 100 = 119.3 kcal (matches audit)
    "olive oil": VerifiedFoodEntry(
        calories_per_100g=884.0,
        protein_per_100g=0.0,
        carbs_per_100g=0.0,
        fat_per_100g=100.0,
        source_name="Oil, olive, salad or cooking",
        default_grams=13.5,
        unit_grams={
            "tbsp": 13.5, "tablespoon": 13.5, "tablespoons": 13.5,
            "tsp": 4.5, "teaspoon": 4.5, "teaspoons": 4.5,
        },
    ),
}


# ---------------------------------------------------------------------------
# Alias table
# ---------------------------------------------------------------------------

# Keys must already be in _normalize_query() form (lowercase, size-stripped).
# Values must be existing keys in _VERIFIED_FOODS.
# Only add an alias when the nutrition values are truly equivalent — i.e. the
# same food, just a different surface form.  Preparation variants that change
# calorie content (e.g. scrambled eggs with butter) are NOT aliased here;
# they fall through to the USDA search path where the profile scoring can pick
# the most accurate cooked-form entry.
_VERIFIED_ALIASES: dict[str, str] = {
    # Plural forms — nutrition identical to singular
    "bananas":         "banana",
    "chicken breasts": "chicken breast",
}


def verified_entry_for_query(normalized_query: str) -> VerifiedFoodEntry | None:
    """Return the verified entry for a pre-normalized query string, or None.

    Checks the alias table when no direct match exists so that plural forms
    (bananas → banana) resolve without duplicating registry entries.
    """
    entry = _VERIFIED_FOODS.get(normalized_query)
    if entry is None:
        canonical = _VERIFIED_ALIASES.get(normalized_query)
        if canonical is not None:
            entry = _VERIFIED_FOODS.get(canonical)
    return entry
