"""
Verified common-food registry for Lume.

Each entry stores audited per-100g nutrition values for a specific USDA source.
Verified entries bypass the live USDA search path entirely — they are looked up
from a static dict whose keys match the output of _normalize_query().

When a query hits a verified entry, _fetch_nutrition returns the pinned
nutrition without any network call.  This makes common whole-food queries
faster, deterministic, and immune to USDA search-index drift.

Per-100g values were pinned from audit runs on 2026-06-03 (phase 8B pilot)
and expanded on 2026-06-16 (phase 8C: top-50 common foods).

    per_100g = audit_total_calories / (profile.default_grams / 100)

To refresh a value, run the audit harness.  If the live result drifts outside
the audit range, update the entry and re-run the full test suite.

Phase 8B: banana, egg/eggs, white rice, olive oil, chicken breast.
Phase 8C: apple, orange, strawberries, blueberries, avocado, grapes, mango,
          watermelon, pineapple, broccoli, spinach, sweet potato, potato,
          carrots, cucumber, tomato, salmon, ground beef, tuna, turkey breast,
          shrimp, bacon, greek yogurt, whole milk, cheddar cheese, cottage
          cheese, butter, brown rice, oatmeal, pasta, quinoa, white bread,
          whole wheat bread, almonds, peanut butter, walnuts, cashews,
          black beans, orange juice.
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
# Per-100g values sourced from USDA FoodData Central (Foundation or SR Legacy).
_VERIFIED_FOODS: dict[str, VerifiedFoodEntry] = {

    # ── Fruits ───────────────────────────────────────────────────────────────

    # 85.0 kcal/100g × 118g default = 100.3 kcal
    "banana": VerifiedFoodEntry(
        calories_per_100g=85.0,
        protein_per_100g=1.1,
        carbs_per_100g=22.8,
        fat_per_100g=0.3,
        source_name="Bananas, overripe, raw",
        default_grams=118,
        unit_grams={"large": 136, "small": 101},
    ),
    # 52.0 kcal/100g × 182g default = 94.6 kcal
    "apple": VerifiedFoodEntry(
        calories_per_100g=52.0,
        protein_per_100g=0.3,
        carbs_per_100g=13.8,
        fat_per_100g=0.2,
        source_name="Apples, raw, with skin",
        default_grams=182,
        unit_grams={"large": 223, "small": 149},
    ),
    # 47.0 kcal/100g × 131g default = 61.6 kcal
    "orange": VerifiedFoodEntry(
        calories_per_100g=47.0,
        protein_per_100g=0.9,
        carbs_per_100g=11.8,
        fat_per_100g=0.1,
        source_name="Oranges, raw, all commercial varieties",
        default_grams=131,
    ),
    # 33.0 kcal/100g × 152g (1 cup) = 50.2 kcal
    "strawberries": VerifiedFoodEntry(
        calories_per_100g=33.0,
        protein_per_100g=0.7,
        carbs_per_100g=7.7,
        fat_per_100g=0.3,
        source_name="Strawberries, raw",
        default_grams=152,
        unit_grams={"cup": 152, "cups": 152},
    ),
    # 57.0 kcal/100g × 148g (1 cup) = 84.4 kcal
    "blueberries": VerifiedFoodEntry(
        calories_per_100g=57.0,
        protein_per_100g=0.7,
        carbs_per_100g=14.5,
        fat_per_100g=0.3,
        source_name="Blueberries, raw",
        default_grams=148,
        unit_grams={"cup": 148, "cups": 148},
    ),
    # 160.0 kcal/100g × 150g default = 240.0 kcal
    "avocado": VerifiedFoodEntry(
        calories_per_100g=160.0,
        protein_per_100g=2.0,
        carbs_per_100g=8.5,
        fat_per_100g=14.7,
        source_name="Avocados, raw, all commercial varieties",
        default_grams=150,
    ),
    # 69.0 kcal/100g × 92g (1/2 cup) = 63.5 kcal
    "grapes": VerifiedFoodEntry(
        calories_per_100g=69.0,
        protein_per_100g=0.7,
        carbs_per_100g=18.1,
        fat_per_100g=0.2,
        source_name="Grapes, red or green (European type varieties), raw",
        default_grams=92,
        unit_grams={"cup": 92, "cups": 92},
    ),
    # 60.0 kcal/100g × 165g (1 cup sliced) = 99.0 kcal
    "mango": VerifiedFoodEntry(
        calories_per_100g=60.0,
        protein_per_100g=0.8,
        carbs_per_100g=15.0,
        fat_per_100g=0.4,
        source_name="Mangos, raw",
        default_grams=165,
        unit_grams={"cup": 165, "cups": 165},
    ),
    # 30.0 kcal/100g × 280g (1 wedge/slice) = 84.0 kcal
    "watermelon": VerifiedFoodEntry(
        calories_per_100g=30.0,
        protein_per_100g=0.6,
        carbs_per_100g=7.6,
        fat_per_100g=0.2,
        source_name="Watermelon, raw",
        default_grams=280,
        unit_grams={"cup": 154, "cups": 154},
    ),
    # 50.0 kcal/100g × 165g (1 cup chunks) = 82.5 kcal
    "pineapple": VerifiedFoodEntry(
        calories_per_100g=50.0,
        protein_per_100g=0.5,
        carbs_per_100g=13.1,
        fat_per_100g=0.1,
        source_name="Pineapple, raw, all varieties",
        default_grams=165,
        unit_grams={"cup": 165, "cups": 165},
    ),

    # ── Vegetables ───────────────────────────────────────────────────────────

    # 35.0 kcal/100g × 156g (1 cup cooked) = 54.6 kcal
    "broccoli": VerifiedFoodEntry(
        calories_per_100g=35.0,
        protein_per_100g=2.4,
        carbs_per_100g=7.2,
        fat_per_100g=0.4,
        source_name="Broccoli, cooked, boiled, drained, without salt",
        default_grams=156,
        unit_grams={"cup": 156, "cups": 156},
    ),
    # 23.0 kcal/100g × 30g (1 cup raw) = 6.9 kcal
    "spinach": VerifiedFoodEntry(
        calories_per_100g=23.0,
        protein_per_100g=2.9,
        carbs_per_100g=3.6,
        fat_per_100g=0.4,
        source_name="Spinach, raw",
        default_grams=30,
        unit_grams={"cup": 30, "cups": 30},
    ),
    # 90.0 kcal/100g × 130g default = 117.0 kcal
    "sweet potato": VerifiedFoodEntry(
        calories_per_100g=90.0,
        protein_per_100g=2.0,
        carbs_per_100g=20.7,
        fat_per_100g=0.2,
        source_name="Sweet potato, cooked, baked in skin, without salt",
        default_grams=130,
    ),
    # 93.0 kcal/100g × 173g (1 medium baked) = 160.9 kcal
    "potato": VerifiedFoodEntry(
        calories_per_100g=93.0,
        protein_per_100g=2.5,
        carbs_per_100g=21.2,
        fat_per_100g=0.1,
        source_name="Potatoes, baked, flesh and skin, without salt",
        default_grams=173,
    ),
    # 41.0 kcal/100g × 61g (1 medium) = 25.0 kcal
    "carrots": VerifiedFoodEntry(
        calories_per_100g=41.0,
        protein_per_100g=0.9,
        carbs_per_100g=9.6,
        fat_per_100g=0.2,
        source_name="Carrots, raw",
        default_grams=61,
        unit_grams={"cup": 128, "cups": 128},
    ),
    # 15.0 kcal/100g × 119g (half medium) = 17.9 kcal
    "cucumber": VerifiedFoodEntry(
        calories_per_100g=15.0,
        protein_per_100g=0.7,
        carbs_per_100g=3.6,
        fat_per_100g=0.1,
        source_name="Cucumbers, with peel, raw",
        default_grams=119,
    ),
    # 18.0 kcal/100g × 123g (1 medium) = 22.1 kcal
    "tomato": VerifiedFoodEntry(
        calories_per_100g=18.0,
        protein_per_100g=0.9,
        carbs_per_100g=3.9,
        fat_per_100g=0.2,
        source_name="Tomatoes, red, ripe, raw, year round average",
        default_grams=123,
    ),

    # ── Proteins ─────────────────────────────────────────────────────────────

    # 148.0 kcal/100g × 50g/egg = 74.0 kcal per egg
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
    # 165.0 kcal/100g × 100g default = 165.0 kcal
    "chicken breast": VerifiedFoodEntry(
        calories_per_100g=165.0,
        protein_per_100g=31.0,
        carbs_per_100g=0.0,
        fat_per_100g=3.6,
        source_name="Chicken, broilers or fryers, breast, meat only, cooked, roasted",
        default_grams=100,
    ),
    # 182.0 kcal/100g × 100g default = 182.0 kcal
    "salmon": VerifiedFoodEntry(
        calories_per_100g=182.0,
        protein_per_100g=25.4,
        carbs_per_100g=0.0,
        fat_per_100g=8.1,
        source_name="Salmon, Atlantic, farmed, cooked, dry heat",
        default_grams=100,
    ),
    # 215.0 kcal/100g × 100g default = 215.0 kcal
    "ground beef": VerifiedFoodEntry(
        calories_per_100g=215.0,
        protein_per_100g=26.1,
        carbs_per_100g=0.0,
        fat_per_100g=11.8,
        source_name="Beef, ground, 85% lean meat / 15% fat, crumbles, cooked, pan-browned",
        default_grams=100,
    ),
    # 116.0 kcal/100g × 85g (1 can drained) = 98.6 kcal
    "tuna": VerifiedFoodEntry(
        calories_per_100g=116.0,
        protein_per_100g=25.5,
        carbs_per_100g=0.0,
        fat_per_100g=1.0,
        source_name="Tuna, light, canned in water, drained solids, no salt added",
        default_grams=85,
        unit_grams={"can": 85, "oz": 28.35},
    ),
    # 135.0 kcal/100g × 85g (3 oz serving) = 114.8 kcal
    "turkey breast": VerifiedFoodEntry(
        calories_per_100g=135.0,
        protein_per_100g=30.1,
        carbs_per_100g=0.0,
        fat_per_100g=1.0,
        source_name="Turkey, breast, meat only, cooked, roasted",
        default_grams=85,
    ),
    # 99.0 kcal/100g × 85g (3 oz serving) = 84.2 kcal
    "shrimp": VerifiedFoodEntry(
        calories_per_100g=99.0,
        protein_per_100g=24.0,
        carbs_per_100g=0.2,
        fat_per_100g=0.3,
        source_name="Shrimp, mixed species, cooked, moist heat",
        default_grams=85,
        unit_grams={"oz": 28.35},
    ),
    # 541.0 kcal/100g × 28g (~2.5 strips) = 151.5 kcal
    "bacon": VerifiedFoodEntry(
        calories_per_100g=541.0,
        protein_per_100g=37.0,
        carbs_per_100g=1.4,
        fat_per_100g=41.8,
        source_name="Pork, cured, bacon, cooked, pan-fried",
        default_grams=28,
        unit_grams={"slice": 10, "slices": 10, "strip": 10, "strips": 10},
    ),

    # ── Dairy ────────────────────────────────────────────────────────────────

    # 59.0 kcal/100g × 170g (1 container) = 100.3 kcal
    "greek yogurt": VerifiedFoodEntry(
        calories_per_100g=59.0,
        protein_per_100g=10.2,
        carbs_per_100g=3.6,
        fat_per_100g=0.4,
        source_name="Yogurt, Greek, plain, nonfat",
        default_grams=170,
        unit_grams={"cup": 245, "cups": 245},
    ),
    # 61.0 kcal/100g × 244g (1 cup) = 148.8 kcal
    "whole milk": VerifiedFoodEntry(
        calories_per_100g=61.0,
        protein_per_100g=3.2,
        carbs_per_100g=4.8,
        fat_per_100g=3.3,
        source_name="Milk, whole, 3.25% milkfat, with added vitamin D",
        default_grams=244,
        unit_grams={"cup": 244, "cups": 244},
    ),
    # 403.0 kcal/100g × 28g (1 oz/slice) = 112.8 kcal
    "cheddar cheese": VerifiedFoodEntry(
        calories_per_100g=403.0,
        protein_per_100g=24.9,
        carbs_per_100g=1.3,
        fat_per_100g=33.1,
        source_name="Cheddar cheese",
        default_grams=28,
        unit_grams={"slice": 28, "slices": 28},
    ),
    # 90.0 kcal/100g × 113g (1/2 cup) = 101.7 kcal
    "cottage cheese": VerifiedFoodEntry(
        calories_per_100g=90.0,
        protein_per_100g=11.1,
        carbs_per_100g=3.4,
        fat_per_100g=2.3,
        source_name="Cheese, cottage, lowfat, 2% milkfat",
        default_grams=113,
        unit_grams={"cup": 226, "cups": 226},
    ),
    # 717.0 kcal/100g × 14g (1 tbsp) = 100.4 kcal
    "butter": VerifiedFoodEntry(
        calories_per_100g=717.0,
        protein_per_100g=0.9,
        carbs_per_100g=0.1,
        fat_per_100g=81.1,
        source_name="Butter, without salt",
        default_grams=14,
        unit_grams={
            "tbsp": 14.2, "tablespoon": 14.2, "tablespoons": 14.2,
            "tsp": 4.7,   "teaspoon": 4.7,    "teaspoons": 4.7,
        },
    ),

    # ── Grains ───────────────────────────────────────────────────────────────

    # 130.0 kcal/100g × 158g (1 cup cooked) = 205.4 kcal
    "white rice": VerifiedFoodEntry(
        calories_per_100g=130.0,
        protein_per_100g=2.7,
        carbs_per_100g=28.2,
        fat_per_100g=0.3,
        source_name="Rice, white, cooked, as ingredient",
        default_grams=158,
        unit_grams={"cup": 158, "cups": 158},
    ),
    # 112.0 kcal/100g × 195g (1 cup cooked) = 218.4 kcal
    "brown rice": VerifiedFoodEntry(
        calories_per_100g=112.0,
        protein_per_100g=2.3,
        carbs_per_100g=23.5,
        fat_per_100g=0.8,
        source_name="Rice, brown, long-grain, cooked",
        default_grams=195,
        unit_grams={"cup": 195, "cups": 195},
    ),
    # 71.0 kcal/100g × 234g (1 cup cooked) = 166.1 kcal
    "oatmeal": VerifiedFoodEntry(
        calories_per_100g=71.0,
        protein_per_100g=2.5,
        carbs_per_100g=12.0,
        fat_per_100g=1.5,
        source_name="Oatmeal, cooked with water, unenriched, without salt",
        default_grams=234,
        unit_grams={"cup": 234, "cups": 234},
    ),
    # 131.0 kcal/100g × 140g (1 cup cooked) = 183.4 kcal
    "pasta": VerifiedFoodEntry(
        calories_per_100g=131.0,
        protein_per_100g=5.0,
        carbs_per_100g=25.0,
        fat_per_100g=1.1,
        source_name="Pasta, cooked, enriched, without added salt",
        default_grams=140,
        unit_grams={"cup": 140, "cups": 140},
    ),
    # 120.0 kcal/100g × 185g (1 cup cooked) = 222.0 kcal
    "quinoa": VerifiedFoodEntry(
        calories_per_100g=120.0,
        protein_per_100g=4.4,
        carbs_per_100g=21.3,
        fat_per_100g=1.9,
        source_name="Quinoa, cooked",
        default_grams=185,
        unit_grams={"cup": 185, "cups": 185},
    ),
    # 265.0 kcal/100g × 28g (1 slice) = 74.2 kcal
    "white bread": VerifiedFoodEntry(
        calories_per_100g=265.0,
        protein_per_100g=8.9,
        carbs_per_100g=49.2,
        fat_per_100g=3.2,
        source_name="Bread, white, commercially prepared",
        default_grams=28,
        unit_grams={"slice": 28, "slices": 28},
    ),
    # 247.0 kcal/100g × 28g (1 slice) = 69.2 kcal
    "whole wheat bread": VerifiedFoodEntry(
        calories_per_100g=247.0,
        protein_per_100g=13.0,
        carbs_per_100g=41.3,
        fat_per_100g=3.4,
        source_name="Bread, whole-wheat, commercially prepared",
        default_grams=28,
        unit_grams={"slice": 28, "slices": 28},
    ),

    # ── Nuts, seeds, and legumes ──────────────────────────────────────────────

    # 579.0 kcal/100g × 28g (1 oz) = 162.1 kcal
    "almonds": VerifiedFoodEntry(
        calories_per_100g=579.0,
        protein_per_100g=21.2,
        carbs_per_100g=21.6,
        fat_per_100g=49.9,
        source_name="Nuts, almonds",
        default_grams=28,
    ),
    # 588.0 kcal/100g × 32g (2 tbsp) = 188.2 kcal
    "peanut butter": VerifiedFoodEntry(
        calories_per_100g=588.0,
        protein_per_100g=25.1,
        carbs_per_100g=20.1,
        fat_per_100g=50.4,
        source_name="Peanut butter, smooth style, with salt",
        default_grams=32,
        unit_grams={"tbsp": 16, "tablespoon": 16, "tablespoons": 16},
    ),
    # 654.0 kcal/100g × 28g (1 oz) = 183.1 kcal
    "walnuts": VerifiedFoodEntry(
        calories_per_100g=654.0,
        protein_per_100g=15.2,
        carbs_per_100g=13.7,
        fat_per_100g=65.2,
        source_name="Nuts, walnuts, english",
        default_grams=28,
        unit_grams={"oz": 28.35, "cup": 117, "cups": 117},
    ),
    # 553.0 kcal/100g × 28g (1 oz) = 154.8 kcal
    "cashews": VerifiedFoodEntry(
        calories_per_100g=553.0,
        protein_per_100g=18.2,
        carbs_per_100g=30.2,
        fat_per_100g=43.9,
        source_name="Nuts, cashew nuts, raw",
        default_grams=28,
        unit_grams={"oz": 28.35, "cup": 137, "cups": 137},
    ),
    # 132.0 kcal/100g × 172g (1 cup cooked) = 226.9 kcal
    "black beans": VerifiedFoodEntry(
        calories_per_100g=132.0,
        protein_per_100g=8.9,
        carbs_per_100g=23.7,
        fat_per_100g=0.5,
        source_name="Beans, black, mature seeds, cooked, boiled, without salt",
        default_grams=172,
        unit_grams={"cup": 172, "cups": 172},
    ),

    # ── Oils ─────────────────────────────────────────────────────────────────

    # 884.0 kcal/100g × 13.5g (1 tbsp) = 119.3 kcal
    "olive oil": VerifiedFoodEntry(
        calories_per_100g=884.0,
        protein_per_100g=0.0,
        carbs_per_100g=0.0,
        fat_per_100g=100.0,
        source_name="Oil, olive, salad or cooking",
        default_grams=13.5,
        unit_grams={
            "tbsp": 13.5, "tablespoon": 13.5, "tablespoons": 13.5,
            "tsp": 4.5,   "teaspoon": 4.5,    "teaspoons": 4.5,
        },
    ),

    # ── Beverages ────────────────────────────────────────────────────────────

    # 45.0 kcal/100g × 248g (1 cup) = 111.6 kcal
    "orange juice": VerifiedFoodEntry(
        calories_per_100g=45.0,
        protein_per_100g=0.7,
        carbs_per_100g=10.4,
        fat_per_100g=0.2,
        source_name="Orange juice, raw",
        default_grams=248,
        unit_grams={"cup": 248, "cups": 248},
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
    # ── Fruits ───────────────────────────────────────────────────────────────
    "bananas":          "banana",
    "apples":           "apple",
    "oranges":          "orange",
    "strawberry":       "strawberries",
    "blueberry":        "blueberries",
    "avocados":         "avocado",
    "grape":            "grapes",
    "mangoes":          "mango",
    "pineapples":       "pineapple",
    # ── Vegetables ───────────────────────────────────────────────────────────
    "carrot":           "carrots",
    "tomatoes":         "tomato",
    "cucumbers":        "cucumber",
    "potatoes":         "potato",
    "baked potato":     "potato",
    "roasted potato":   "potato",
    "roasted potatoes": "potato",
    "baked potatoes":   "potato",
    "steamed broccoli": "broccoli",
    "roasted broccoli": "broccoli",
    "roasted sweet potato":  "sweet potato",
    "baked sweet potato":    "sweet potato",
    "steamed sweet potato":  "sweet potato",
    # ── Proteins ─────────────────────────────────────────────────────────────
    "chicken":          "chicken breast",
    "chicken breasts":  "chicken breast",
    "tuna fish":        "tuna",
    "canned tuna":      "tuna",
    # Salmon prep variants (smoked/raw excluded — different macros)
    "grilled salmon":   "salmon",
    "baked salmon":     "salmon",
    "pan seared salmon": "salmon",
    "steamed salmon":   "salmon",
    # Egg prep variants
    "hard boiled egg":  "egg",
    "hard boiled eggs": "eggs",
    "soft boiled egg":  "egg",
    "soft boiled eggs": "eggs",
    # Chicken prep variants (fried excluded — batter/oil changes macros)
    "baked chicken":    "chicken breast",
    "pan seared chicken": "chicken breast",
    # ── Dairy ────────────────────────────────────────────────────────────────
    "greek yoghurt":    "greek yogurt",
    # ── Grains ───────────────────────────────────────────────────────────────
    "wheat bread":      "whole wheat bread",
    "whole grain bread": "whole wheat bread",
    # ── Nuts / legumes ───────────────────────────────────────────────────────
    "almond":           "almonds",
    "walnut":           "walnuts",
    "cashew":           "cashews",
    "black bean":       "black beans",
    "beans":            "black beans",
    # ── Beverages ────────────────────────────────────────────────────────────
    "oj":               "orange juice",
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
