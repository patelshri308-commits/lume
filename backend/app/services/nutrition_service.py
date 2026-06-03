import os
from dataclasses import dataclass, field
import httpx
from app.services.debug_logger import log_usda_candidates, log_rejection

# ---------------------------------------------------------------------------
# USDA FoodData Central API
# Get a free key at: https://fdc.nal.usda.gov/api-key-signup.html
# "DEMO_KEY" works without signing up but is limited to 30 requests/hour.
# ---------------------------------------------------------------------------
USDA_API_KEY    = os.getenv("USDA_API_KEY", "DEMO_KEY")
USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"

# USDA identifies each nutrient by a fixed numeric ID.
NUTRIENT_ID_CALORIES = 1008  # Energy (kcal) — older USDA / Branded / SR Legacy
# Foundation foods added after ~2020 store energy under Atwater-factor IDs
# instead of 1008.  We try all three and take the first non-zero value.
_ENERGY_NUTRIENT_IDS = (1008, 2047, 2048)

NUTRIENT_ID_PROTEIN  = 1003  # Protein
NUTRIENT_ID_CARBS    = 1005  # Carbohydrate, by difference
NUTRIENT_ID_FAT      = 1004  # Total lipid (fat)

# USDA data types, ranked from most generic to most branded.
# Foundation and SR Legacy are USDA's own scientific databases.
# Branded items are manufacturer-submitted and often irrelevant for generic queries.
DATA_TYPE_SCORE = {
    "Foundation":      30,   # Best: USDA-tested, plain whole foods
    "SR Legacy":       20,   # Good: older USDA reference database, still reliable
    "Survey (FNDDS)":  10,   # OK:   used in dietary surveys
    "Branded":        -30,   # Avoid: manufacturer data, often processed products
}

# Non-branded USDA data types used when the caller requests generic-food data.
# Passing these as a `dataType` filter to the USDA search endpoint prevents
# the API from returning manufacturer-submitted branded entries in the result
# pool.  This matters because USDA's full-text search ranks exact phrase matches
# first: a branded product named "Chicken Breast" outranks the Foundation entry
# "Chicken, broilers or fryers, breast, meat only, raw" purely on text score,
# even though our internal scorer would prefer the Foundation entry.  Filtering
# at the API level ensures the pool only contains scoreable scientific data.
_GENERIC_DATA_TYPES: list[str] = ["Foundation", "SR Legacy", "Survey (FNDDS)"]

# Minimum score a candidate must reach before we trust it as a real match.
# A Foundation item with zero query-word matches scores at most 29 (30 − len//10).
# A Foundation item with one word match scores at least 39 (30 + 15 − 6).
# This threshold therefore rejects matches driven purely by data-type preference
# with no lexical support from the user's query.
CONFIDENCE_THRESHOLD = 30

# Words that suggest a result is a processed or compound food, not a plain ingredient.
# Matching any of these penalises the result so it ranks lower.
PROCESSED_KEYWORDS = [
    "chips", "bread", "cake", "muffin", "shake", "smoothie",
    "powder", "flavored", "flavoured", "dried", "juice", "extract",
    "supplement", "bar", "mix", "sauce", "spread", "candy",
]


@dataclass(frozen=True)
class GenericFoodProfile:
    """Canonical guidance for common generic foods.

    USDA search is precise but not user-friendly by default: it often returns
    per-100g ingredient records, dry foods, flours, oils, or processed variants.
    Profiles encode Lume's default serving and ranking intent for common whole
    foods while still using USDA as the nutrition source.
    """
    search_query: str
    default_grams: float = 100.0
    prefer_terms: tuple[str, ...] = ()
    avoid_terms: tuple[str, ...] = ()
    unit_grams: dict[str, float] = field(default_factory=dict)


_COOKED_DEFAULT_AVOIDS = ("raw", "dry", "dried", "flour", "oil", "tots", "chips")

_GENERIC_FOOD_PROFILES: dict[str, GenericFoodProfile] = {
    "banana": GenericFoodProfile(
        search_query="banana raw",
        default_grams=118,
        prefer_terms=("banana", "raw"),
        avoid_terms=("nectar", "baked", "chips", "babyfood"),
        unit_grams={"large": 136, "small": 101},
    ),
    "apple": GenericFoodProfile(
        search_query="apple raw",
        default_grams=182,
        prefer_terms=("apple", "raw"),
        avoid_terms=("candied", "juice", "sauce", "dried", "pie"),
        unit_grams={"large": 223, "small": 149},
    ),
    "orange": GenericFoodProfile(
        search_query="orange raw",
        default_grams=131,
        prefer_terms=("orange", "raw"),
        avoid_terms=("juice", "drink", "peel", "marmalade"),
    ),
    "strawberries": GenericFoodProfile(
        search_query="strawberries raw",
        default_grams=152,
        prefer_terms=("strawberries", "raw"),
        avoid_terms=("syrup", "frozen", "sweetened", "jam"),
        unit_grams={"cup": 152, "cups": 152},
    ),
    "blueberries": GenericFoodProfile(
        search_query="blueberries raw",
        default_grams=148,
        prefer_terms=("blueberries", "raw"),
        avoid_terms=("dried", "syrup", "muffin", "jam"),
        unit_grams={"cup": 148, "cups": 148},
    ),
    "avocado": GenericFoodProfile(
        search_query="avocado raw",
        default_grams=150,
        prefer_terms=("avocado", "raw"),
        avoid_terms=("oil", "dip", "guacamole"),
    ),
    "broccoli": GenericFoodProfile(
        search_query="broccoli cooked",
        default_grams=156,
        prefer_terms=("broccoli", "cooked"),
        avoid_terms=("raw", "soup", "casserole", "babyfood"),
        unit_grams={"cup": 156, "cups": 156},
    ),
    "spinach": GenericFoodProfile(
        search_query="spinach raw",
        default_grams=30,
        prefer_terms=("spinach", "raw"),
        avoid_terms=("dip", "souffle", "cooked"),
        unit_grams={"cup": 30, "cups": 30},
    ),
    "potato": GenericFoodProfile(
        search_query="potato baked flesh",
        default_grams=173,
        prefer_terms=("potato", "baked"),
        avoid_terms=("chips", "fries", "tots", "flour", "raw"),
    ),
    "sweet potato": GenericFoodProfile(
        search_query="sweet potato cooked baked",
        default_grams=130,
        prefer_terms=("sweet", "potato", "cooked"),
        avoid_terms=("tots", "fries", "chips", "flour", "raw"),
    ),
    "white rice": GenericFoodProfile(
        search_query="rice white cooked",
        default_grams=158,
        prefer_terms=("rice", "white", "cooked"),
        avoid_terms=("flour", "dry", "uncooked", "bran", "glutinous"),
        unit_grams={"cup": 158, "cups": 158},
    ),
    "brown rice": GenericFoodProfile(
        search_query="rice brown cooked",
        default_grams=195,
        prefer_terms=("rice", "brown", "cooked"),
        avoid_terms=("flour", "dry", "uncooked", "bran"),
        unit_grams={"cup": 195, "cups": 195},
    ),
    "rice": GenericFoodProfile(
        search_query="rice white cooked",
        default_grams=158,
        prefer_terms=("rice", "cooked"),
        avoid_terms=("flour", "dry", "uncooked", "bran", "glutinous"),
        unit_grams={"cup": 158, "cups": 158},
    ),
    "oatmeal": GenericFoodProfile(
        search_query="oatmeal cooked",
        default_grams=234,
        prefer_terms=("oatmeal", "cooked"),
        avoid_terms=("cookie", "bar", "dry", "instant flavored"),
        unit_grams={"cup": 234, "cups": 234},
    ),
    "eggs": GenericFoodProfile(
        search_query="egg whole",
        default_grams=50,
        prefer_terms=("egg", "whole", "boiled", "raw"),
        avoid_terms=("white", "substitute", "powder", "fried"),
    ),
    "egg": GenericFoodProfile(
        search_query="egg whole",
        default_grams=50,
        prefer_terms=("egg", "whole", "boiled", "raw"),
        avoid_terms=("white", "substitute", "powder", "fried"),
    ),
    "chicken breast": GenericFoodProfile(
        search_query="chicken breast cooked roasted",
        default_grams=100,
        prefer_terms=("chicken", "breast", "cooked"),
        avoid_terms=("raw", "skin", "breaded", "fried", "canned"),
    ),
    "salmon": GenericFoodProfile(
        search_query="salmon cooked",
        default_grams=100,
        prefer_terms=("salmon", "cooked"),
        avoid_terms=("oil", "raw", "smoked", "canned"),
    ),
    "ground beef": GenericFoodProfile(
        search_query="ground beef cooked",
        default_grams=100,
        prefer_terms=("beef", "ground", "cooked"),
        avoid_terms=("raw", "patty", "meatballs"),
    ),
    "greek yogurt": GenericFoodProfile(
        search_query="yogurt greek plain",
        default_grams=170,
        prefer_terms=("yogurt", "greek", "plain"),
        avoid_terms=("flavored", "sweetened", "frozen"),
        unit_grams={"cup": 245, "cups": 245},
    ),
    "whole milk": GenericFoodProfile(
        search_query="milk whole",
        default_grams=244,
        prefer_terms=("milk", "whole"),
        avoid_terms=("cheese", "powder", "evaporated", "chocolate", "buttermilk"),
        unit_grams={"cup": 244, "cups": 244},
    ),
    "cheddar cheese": GenericFoodProfile(
        search_query="cheese cheddar",
        default_grams=28,
        prefer_terms=("cheese", "cheddar"),
        avoid_terms=("sauce", "spread", "powder"),
        unit_grams={"slice": 28, "slices": 28},
    ),
    "almonds": GenericFoodProfile(
        search_query="nuts almonds",
        default_grams=28,
        prefer_terms=("nuts", "almonds"),
        avoid_terms=("butter", "milk", "flour", "oil", "paste"),
    ),
    "peanut butter": GenericFoodProfile(
        search_query="peanut butter",
        default_grams=32,
        prefer_terms=("peanut", "butter"),
        avoid_terms=("powder", "reduced fat"),
        unit_grams={"tbsp": 16, "tablespoon": 16, "tablespoons": 16},
    ),
    "olive oil": GenericFoodProfile(
        search_query="olive oil",
        default_grams=13.5,
        prefer_terms=("olive", "oil"),
        avoid_terms=("spray", "dressing", "corn", "peanut", "canola", "soybean", "vegetable", "sunflower"),
        unit_grams={"tbsp": 13.5, "tablespoon": 13.5, "tablespoons": 13.5, "tsp": 4.5, "teaspoon": 4.5, "teaspoons": 4.5},
    ),
    "black beans": GenericFoodProfile(
        search_query="black beans cooked",
        default_grams=172,
        prefer_terms=("beans", "black", "cooked"),
        avoid_terms=("dry", "dried", "flour", "raw"),
        unit_grams={"cup": 172, "cups": 172},
    ),
    "pasta": GenericFoodProfile(
        search_query="pasta cooked",
        default_grams=140,
        prefer_terms=("pasta", "cooked"),
        avoid_terms=("dry", "uncooked", "sauce", "gluten-free"),
        unit_grams={"cup": 140, "cups": 140},
    ),
}


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _score_food(food: dict, query: str, profile: GenericFoodProfile | None = None) -> int:
    """
    Assign a score to a USDA result. Higher score = better match for a generic query.
    This is used to pick the best result from a list of candidates.

    Phase 2 additions
    ─────────────────
    • Zero-match penalty: if NO query word appears anywhere in the description,
      deduct 40 points.  This prevents irrelevant Foundation items from clearing
      the threshold on data-type score alone when the query is unrelated.
    • Primary-word bonus (+10): if the first comma-delimited segment of the
      description starts with a query word, the result is likely the main food
      (e.g. "Bananas, raw" for query "banana") rather than a dish that contains
      the food as an ingredient.
    """
    score       = 0
    description = food.get("description", "").lower()
    data_type   = food.get("dataType", "Branded")
    query_words = set(query.lower().split())

    # Reward generic data types, penalise branded ones
    score += DATA_TYPE_SCORE.get(data_type, -30)

    # Reward every query word that appears in the description.
    # Also try a simple singular form (strip trailing "s") so that
    # "eggs" matches "egg, whole, raw, fresh", "oats" matches "oat", etc.
    word_matches = 0
    for word in query_words:
        stem = word[:-1] if len(word) > 3 and word.endswith("s") else word
        if word in description or stem in description:
            score += 15
            word_matches += 1

    # Phase 2: hard penalty for zero-match results.
    # Without this, a Foundation item for an unrelated food can score ~28
    # (30 - len//10) and narrowly pass the CONFIDENCE_THRESHOLD of 30.
    if word_matches == 0:
        score -= 40

    # Phase 2: primary-word bonus.
    # "Bananas, raw" → primary segment = "bananas" → matches query "banana" → +10.
    # Rewards results where the food IS the main subject, not just an ingredient.
    primary_segment = description.split(",")[0].strip().rstrip("s")
    for word in query_words:
        stem = word[:-1] if len(word) > 3 and word.endswith("s") else word
        if stem == primary_segment or word == primary_segment:
            score += 10
            break  # only once regardless of how many query words match

    # Penalise descriptions that contain processed-food keywords —
    # but only when those keywords were NOT part of the user's query.
    # Without this guard, searching "orange juice" or "banana bread"
    # would penalise the best matching results.
    for keyword in PROCESSED_KEYWORDS:
        if keyword in description and keyword not in query_words:
            score -= 20

    if profile is not None:
        for term in profile.prefer_terms:
            if term in description:
                score += 12
        for term in profile.avoid_terms:
            if term in description:
                score -= 35

    nutrients = food.get("foodNutrients", [])
    if nutrients:
        calories = _extract_calories(nutrients)
        protein = _extract_nutrient(nutrients, NUTRIENT_ID_PROTEIN)
        carbs = _extract_nutrient(nutrients, NUTRIENT_ID_CARBS)
        fat = _extract_nutrient(nutrients, NUTRIENT_ID_FAT)
        if calories == 0 and protein == 0 and carbs == 0 and fat == 0:
            score -= 100

    # Shorter descriptions tend to be plainer foods ("Bananas, raw" beats
    # "Banana cream pie filling, canned, ready to serve").
    score -= len(description) // 10

    return score


def _profile_for_query(query: str) -> GenericFoodProfile | None:
    """Return a canonical generic-food profile for an already-core food query."""
    q = _normalize_query(query)
    return _GENERIC_FOOD_PROFILES.get(q)


def _grams_from_unit(unit: str, quantity: float, profile: GenericFoodProfile) -> float | None:
    """Convert supported user units to grams for the given canonical food."""
    u = unit.lower()
    if u in {"g", "gram", "grams"}:
        return quantity
    if u in {"kg", "kilogram", "kilograms"}:
        return quantity * 1000
    if u in {"oz", "ounce", "ounces"}:
        return quantity * 28.3495
    if u in {"lb", "lbs", "pound", "pounds"}:
        return quantity * 453.592
    grams_per_unit = profile.unit_grams.get(u)
    if grams_per_unit is not None:
        return quantity * grams_per_unit
    return None


def _extract_nutrient(nutrients: list, nutrient_id: int) -> float:
    """Find a nutrient value by its ID inside a USDA food's nutrient list."""
    for nutrient in nutrients:
        if nutrient.get("nutrientId") == nutrient_id:
            return round(nutrient.get("value", 0), 1)
    return 0.0


def _extract_calories(nutrients: list) -> float:
    """
    Extract energy (kcal) tolerating the two nutrient-ID conventions used by
    different USDA data types:

      1008 — Energy (kcal)                 Branded, SR Legacy, older Foundation
      2047 — Energy (Atwater General)      Foundation foods added after ~2020
      2048 — Energy (Atwater Specific)     Some Foundation / experimental entries

    Returns the first non-zero value found across all three IDs so that
    Foundation chicken breast data (which uses 2047) is not silently zeroed.
    """
    for nid in _ENERGY_NUTRIENT_IDS:
        val = _extract_nutrient(nutrients, nid)
        if val:
            return val
    return 0.0


def _get_fallback_nutrition(query: str) -> dict:  # always returns is_estimated: True
    """Rule-based fallback used when the USDA API is unavailable or returns nothing."""
    q = query.lower()

    # ── Phrase priority ───────────────────────────────────────────────────────
    # Multi-word category phrases must be checked BEFORE single-ingredient
    # keywords so that "banana smoothie" returns smoothie nutrition (not banana),
    # "apple juice" returns juice nutrition (not apple), etc.
    # Ordering within this block still matters: "orange juice" before "juice",
    # "protein bar" before any candy/nut checks further down.
    if "frappuccino" in q or "frappe" in q:
        return {"calories": 400, "protein": 5,  "carbs": 60, "fat": 15}
    if "milkshake" in q or "milk shake" in q:
        return {"calories": 500, "protein": 10, "carbs": 70, "fat": 20}
    if "smoothie" in q:
        return {"calories": 300, "protein": 5,  "carbs": 55, "fat": 5}
    if "latte" in q or "cappuccino" in q:
        return {"calories": 150, "protein": 8,  "carbs": 15, "fat": 6}
    if "protein bar" in q:
        return {"calories": 250, "protein": 20, "carbs": 25, "fat": 8}
    if "granola bar" in q or "granola" in q:
        return {"calories": 200, "protein": 4,  "carbs": 30, "fat": 7}
    if "orange juice" in q:
        return {"calories": 110, "protein": 2,  "carbs": 26, "fat": 0}
    if "juice" in q:
        return {"calories": 120, "protein": 1,  "carbs": 28, "fat": 0}

    # ── Fruit ─────────────────────────────────────────────────────────────────
    if "apple" in q:
        return {"calories": 95,  "protein": 0,  "carbs": 25, "fat": 0}
    if "banana" in q:
        return {"calories": 90,  "protein": 1,  "carbs": 23, "fat": 0}

    # ── American / fast food ──────────────────────────────────────────────────
    if "burger" in q or "pizza" in q:
        return {"calories": 650, "protein": 30, "carbs": 55, "fat": 35}
    if "fries" in q or "fry" in q:
        return {"calories": 400, "protein": 5,  "carbs": 50, "fat": 18}

    # ── Mexican ───────────────────────────────────────────────────────────────
    if "burrito" in q:
        return {"calories": 700, "protein": 30, "carbs": 75, "fat": 25}
    if "taco" in q:
        return {"calories": 250, "protein": 12, "carbs": 20, "fat": 12}

    # ── Asian ─────────────────────────────────────────────────────────────────
    if "sushi" in q:
        return {"calories": 350, "protein": 15, "carbs": 50, "fat": 8}
    if "ramen" in q:
        return {"calories": 500, "protein": 25, "carbs": 60, "fat": 15}
    if "curry" in q:
        return {"calories": 450, "protein": 20, "carbs": 45, "fat": 20}

    # ── Sandwiches ────────────────────────────────────────────────────────────
    if "sandwich" in q or "wrap" in q or "sub" in q:
        return {"calories": 450, "protein": 25, "carbs": 45, "fat": 15}

    # ── Pasta / noodles ───────────────────────────────────────────────────────
    if "pasta" in q or "spaghetti" in q or "noodle" in q:
        return {"calories": 500, "protein": 20, "carbs": 65, "fat": 15}

    # ── Bakery ────────────────────────────────────────────────────────────────
    if "bagel" in q:
        return {"calories": 300, "protein": 10, "carbs": 55, "fat": 2}
    if "muffin" in q:
        return {"calories": 400, "protein": 5,  "carbs": 55, "fat": 15}
    if "donut" in q or "doughnut" in q:
        return {"calories": 300, "protein": 3,  "carbs": 35, "fat": 15}
    if "pancake" in q or "waffle" in q:
        return {"calories": 400, "protein": 10, "carbs": 55, "fat": 15}

    # ── Desserts ──────────────────────────────────────────────────────────────
    if "ice cream" in q or "gelato" in q or "sorbet" in q:
        return {"calories": 250, "protein": 3,  "carbs": 30, "fat": 13}
    if "cupcake" in q:                               # must precede "cake" check
        return {"calories": 300, "protein": 3,  "carbs": 40, "fat": 15}
    if "cake" in q:                                  # also catches cheesecake, birthday cake
        return {"calories": 350, "protein": 4,  "carbs": 50, "fat": 15}
    if "brownie" in q:
        return {"calories": 250, "protein": 3,  "carbs": 35, "fat": 12}
    if "cookie" in q:
        return {"calories": 200, "protein": 2,  "carbs": 28, "fat": 9}
    if "pastry" in q or "croissant" in q or "danish" in q:
        return {"calories": 300, "protein": 5,  "carbs": 35, "fat": 16}

    # ── Snacks ────────────────────────────────────────────────────────────────
    if "chips" in q or "crisps" in q:
        return {"calories": 150, "protein": 2,  "carbs": 15, "fat": 10}
    if "cracker" in q:
        return {"calories": 150, "protein": 3,  "carbs": 20, "fat": 6}
    if "popcorn" in q:
        return {"calories": 150, "protein": 3,  "carbs": 18, "fat": 8}
    if "protein bar" in q:
        return {"calories": 250, "protein": 20, "carbs": 25, "fat": 8}
    if "granola bar" in q or "granola" in q:
        return {"calories": 200, "protein": 4,  "carbs": 30, "fat": 7}
    if "trail mix" in q:
        return {"calories": 300, "protein": 8,  "carbs": 30, "fat": 18}
    if "candy" in q:
        return {"calories": 200, "protein": 0,  "carbs": 35, "fat": 5}

    # ── Beverages ─────────────────────────────────────────────────────────────
    # Coconut water — must come BEFORE the plain-water rule so it is never
    # zeroed by the " water" suffix match below.
    if "coconut water" in q:
        return {"calories": 45, "protein": 0, "carbs": 11, "fat": 0}

    # Plain water variants — checked before any other beverage rule so that
    # "sparkling water", "mineral water", etc. never hit the generic fallback.
    # "flavored water" is intentionally excluded here (may have calories).
    if (
        q == "water"
        or (q.endswith(" water") and any(w in q for w in ("sparkling", "mineral", "bottled", "still", "tap", "plain", "distilled")))
    ):
        return {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}

    # Diet / zero-sugar drinks must be checked FIRST so they do not fall
    # through to the regular soda / energy-drink branches above.
    _is_diet = ("diet" in q or "zero sugar" in q or "sugar free" in q
                or "coke zero" in q or "pepsi zero" in q or "zero" in q.split())
    if _is_diet:
        _diet_soda    = any(w in q for w in ("soda", "cola", "coke", "pepsi", "lemon lime", "sprite"))
        _diet_energy  = any(w in q for w in ("energy drink", "red bull", "monster", "energy"))
        if _diet_soda:
            return {"calories": 0,  "protein": 0, "carbs": 0, "fat": 0}
        if _diet_energy:
            return {"calories": 10, "protein": 0, "carbs": 1, "fat": 0}

    # Specific checks must precede their generic parent:
    #   frappuccino/frappe → before coffee
    #   iced tea           → before tea
    #   orange juice       → before juice   (note: "apple juice" is caught earlier by "apple")
    if "frappuccino" in q or "frappe" in q:
        return {"calories": 400, "protein": 5,  "carbs": 60, "fat": 15}
    if "milkshake" in q or "milk shake" in q:
        return {"calories": 500, "protein": 10, "carbs": 70, "fat": 20}
    if "smoothie" in q:
        return {"calories": 300, "protein": 5,  "carbs": 55, "fat": 5}
    if "latte" in q or "cappuccino" in q:
        return {"calories": 150, "protein": 8,  "carbs": 15, "fat": 6}
    # Plain / black coffee — must come before the generic "coffee" branch so
    # that explicit zero-calorie queries don't inherit the generic estimate.
    # Conservative: only matches queries that are unambiguously black/plain.
    # "iced coffee", "coffee with milk", "latte", "frappuccino" are all caught
    # earlier or fall through to the generic coffee rule below.
    if (
        q in ("black coffee", "plain coffee", "coffee black", "coffee, black")
        or q == "coffee"
    ):
        return {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}
    if "coffee" in q:
        return {"calories": 50,  "protein": 1,  "carbs": 8,  "fat": 2}
    if "orange juice" in q:
        return {"calories": 110, "protein": 2,  "carbs": 26, "fat": 0}
    if "juice" in q:
        return {"calories": 120, "protein": 1,  "carbs": 28, "fat": 0}
    if "soda" in q or "cola" in q or "coke" in q or "pepsi" in q or "sprite" in q:
        return {"calories": 150, "protein": 0,  "carbs": 40, "fat": 0}
    if "lemonade" in q:
        return {"calories": 150, "protein": 0,  "carbs": 38, "fat": 0}
    if "sports drink" in q or "gatorade" in q or "powerade" in q:
        return {"calories": 100, "protein": 0,  "carbs": 25, "fat": 0}
    if "energy drink" in q or "red bull" in q or "monster" in q:
        return {"calories": 150, "protein": 1,  "carbs": 35, "fat": 0}
    if "sweet tea" in q or "sweetened tea" in q:    # must precede generic tea
        return {"calories": 120, "protein": 0,  "carbs": 30, "fat": 0}
    if "iced tea" in q:                              # must precede "tea" check
        return {"calories": 100, "protein": 0,  "carbs": 25, "fat": 0}
    if "tea" in q:
        return {"calories": 0,   "protein": 0,  "carbs": 0,  "fat": 0}

    # ── Generic fallback ──────────────────────────────────────────────────────
    return {"calories": 250, "protein": 10, "carbs": 20, "fat": 15}


# ---------------------------------------------------------------------------
# Query normalizer
# ---------------------------------------------------------------------------

def _normalize_query(query: str) -> str:
    """
    Light normalization applied before USDA lookup and fallback matching.
    Improves handling of common real-world query messiness:
      - "with" add-ons     "burrito with guac"     → "burrito"
      - Leading digits     "2 donuts"               → "donuts"
      - Number words       "three tacos"            → "tacos"
      - Filler articles    "a latte" / "the burger" → "latte" / "burger"
      - Size modifiers     "large fries"            → "fries"
    Preserves meaningful descriptors: "iced", "grilled", "banana", "chocolate".
    """
    q = query.lower().strip()

    # NOTE: "with ..." clauses are intentionally NOT stripped here.
    # The query router (Phase 1) now classifies queries with "with" components
    # as COMPOSITE_MEAL and passes the full text so nothing meaningful is lost.
    # Stripping "with milk" from "coffee with milk" was returning black-coffee
    # nutrition (0 cal) instead of a correct estimate — that bug is fixed by
    # preserving the clause and letting the USDA query and fallback rules
    # match against the full phrase.

    # Strip a leading standalone digit: "2 donuts" → "donuts"
    words = q.split()
    if words and words[0].isdigit():
        words = words[1:]
        q = " ".join(words)

    # Strip a leading number word or filler article
    _LEADING = {"one", "two", "three", "four", "five", "six", "seven",
                "eight", "nine", "ten", "a", "an", "the"}
    words = q.split()
    if words and words[0] in _LEADING:
        words = words[1:]
        q = " ".join(words)

    # Remove size/quantity modifiers wherever they appear in the query
    _SIZE = {"small", "medium", "large", "grande", "venti", "tall",
             "mini", "regular", "extra", "double", "triple"}
    words = [w for w in q.split() if w not in _SIZE]

    return " ".join(words).strip()


# ---------------------------------------------------------------------------
# Quantity extractor
# ---------------------------------------------------------------------------

def _extract_leading_quantity(query: str) -> int:
    """
    Return the leading integer quantity from a query (2–9 only), or 1 if none.
    Supports digit form ("2 donuts") and number words ("three tacos").
    Only inspects the first word so it never fires on mid-query numbers.
    Capped at 9 to avoid obviously nonsensical multiplications.

    Safety guard: if the second token is a measurement/unit word (oz, cups,
    slices, grams, etc.) the number describes a serving size, not a whole-item
    count — return 1 so multiplication is skipped.
    """
    _WORD_TO_INT = {
        "two": 2, "three": 3, "four": 4, "five": 5,
        "six": 6, "seven": 7, "eight": 8, "nine": 9,
    }
    # Unit words that signal the leading number is a measurement, not a count.
    _UNITS = {
        "oz", "ounce", "ounces",
        "g", "gram", "grams",
        "lb", "lbs", "pound", "pounds",
        "cup", "cups",
        "tbsp", "tsp",
        "slice", "slices",
        "fl", "floz", "ml", "l",
        "serving", "servings",
        "piece", "pieces",
    }
    words = query.strip().lower().split()
    if not words:
        return 1

    first = words[0]

    # Determine the raw candidate quantity
    candidate = None
    if first.isdigit():
        n = int(first)
        if 2 <= n <= 9:
            candidate = n
    else:
        candidate = _WORD_TO_INT.get(first)

    if candidate is None:
        return 1

    # Block scaling when the second token is a unit word
    if len(words) >= 2 and words[1] in _UNITS:
        return 1

    return candidate


# ---------------------------------------------------------------------------
# Single-serving lookup (internal) + public wrapper with quantity scaling
# ---------------------------------------------------------------------------

def _fetch_nutrition(query: str, prefer_generic: bool = False) -> dict:
    """
    Fetch single-serving nutrition data from USDA FoodData Central.
    Scores the candidates and picks the best generic match.
    Falls back to rule-based estimates if the API fails or returns no results.

    prefer_generic flag
    ───────────────────
    When True, the USDA request includes a dataType filter that restricts
    results to Foundation, SR Legacy, and Survey (FNDDS) — excluding all
    Branded (manufacturer-submitted) entries from the result pool.

    Use this for GENERIC_FOOD queries (whole foods, plain ingredients) where:
    • Branded entries dominate USDA's text-search results due to exact phrase
      matching ("Chicken Breast" product wins over "Chicken, broilers …, breast"),
      and
    • All Branded entries score ≤ -1 in our internal scorer, falling below
      CONFIDENCE_THRESHOLD and forcing an unnecessary fallback to rule-based
      estimates even though USDA has accurate Foundation data available.

    Leave False (default) for fallback paths from branded/restaurant routing
    where the caller explicitly wants any available USDA data as a last resort.
    """
    profile = _profile_for_query(query) if prefer_generic else None
    query = profile.search_query if profile is not None else _normalize_query(query)

    # Read the key at call time (not module-level) so that test fixtures or
    # conftest.py that load .env after import still pick up the real key.
    api_key = os.getenv("USDA_API_KEY", "DEMO_KEY")

    params: dict = {
        "query":    query,
        "api_key":  api_key,
        "pageSize": 10,   # Fetch a pool of candidates so we can rank them
    }
    if prefer_generic:
        # Restrict to scientific databases; exclude manufacturer-submitted entries.
        params["dataType"] = _GENERIC_DATA_TYPES

    try:
        response = httpx.get(
            USDA_SEARCH_URL,
            params=params,
            timeout=5.0,
        )
        if response.status_code == 400 and prefer_generic and "dataType" in params:
            retry_params = dict(params)
            retry_params.pop("dataType", None)
            response = httpx.get(
                USDA_SEARCH_URL,
                params=retry_params,
                timeout=5.0,
            )
        response.raise_for_status()

        foods = response.json().get("foods", [])

        if not foods:
            log_rejection(query, "usda_no_results")
            return {**_get_fallback_nutrition(query), "is_estimated": True}

        # Score every candidate, then pick the best.
        # Attach _score to each dict so debug logging can show it without
        # re-computing.
        for food in foods:
            food["_score"] = _score_food(food, query, profile)

        best_food  = max(foods, key=lambda f: f["_score"])
        best_score = best_food["_score"]

        # Debug: show the top candidates and their scores.
        log_usda_candidates(
            query,
            sorted(foods, key=lambda f: f["_score"], reverse=True),
        )

        # Reject weak matches: if even the best candidate didn't earn enough
        # score to clear the threshold, no query word appeared in any result —
        # returning it would be misleading.
        if best_score < CONFIDENCE_THRESHOLD:
            log_rejection(query, "usda_score_below_threshold",
                          {"score": best_score, "threshold": CONFIDENCE_THRESHOLD,
                           "best": best_food.get("description", "")})
            return {**_get_fallback_nutrition(query), "is_estimated": True}

        nutrients = best_food.get("foodNutrients", [])
        calories  = _extract_calories(nutrients)
        protein   = _extract_nutrient(nutrients, NUTRIENT_ID_PROTEIN)
        carbs     = _extract_nutrient(nutrients, NUTRIENT_ID_CARBS)
        fat       = _extract_nutrient(nutrients, NUTRIENT_ID_FAT)

        if calories == 0 and (protein > 0 or carbs > 0 or fat > 0):
            calories = round((protein * 4) + (carbs * 4) + (fat * 9), 1)

        # Sanity check: for known meal/drink categories, reject USDA results
        # whose calorie count is implausibly low.  This catches cases where a
        # high-scoring ingredient (e.g. plain chicken) wins for a full-meal
        # query (e.g. "chicken burrito") and returns ingredient-level data
        # that looks precise but is clearly wrong for the whole dish.
        # Thresholds are intentionally conservative — only block obvious misses.
        _MEAL_CALORIE_FLOOR = {
            "burrito":     300,
            "taco":        100,
            "sandwich":    200,
            "wrap":        200,
            "burger":      250,
            "pizza":       200,
            "smoothie":    150,
            "latte":        80,
            "cappuccino":   80,
            "frappuccino": 250,
            "milkshake":   250,
            "ramen":       300,
            "pasta":       250,
            "spaghetti":   250,
        }
        if profile is None:
            for keyword, floor in _MEAL_CALORIE_FLOOR.items():
                if keyword in query and calories < floor:
                    log_rejection(query, "usda_meal_calorie_floor",
                                  {"keyword": keyword, "calories": calories, "floor": floor,
                                   "usda_desc": best_food.get("description", "")})
                    return {**_get_fallback_nutrition(query), "is_estimated": True}

        return {
            "calories":     calories,
            "protein":      protein,
            "carbs":        carbs,
            "fat":          fat,
            "is_estimated": False,
            "source_name":  best_food.get("description", ""),  # USDA item description
            "serving_description": "per 100g",
        }

    except Exception as exc:
        api_key_type = "DEMO_KEY" if os.getenv("USDA_API_KEY", "DEMO_KEY") == "DEMO_KEY" else "real_key"
        log_rejection(query, "usda_exception", {
            "type":         type(exc).__name__,
            "detail":       str(exc)[:300],
            "api_key_type": api_key_type,
        })
        return {**_get_fallback_nutrition(query), "is_estimated": True}


# ---------------------------------------------------------------------------
# Phase 4: size-modifier multipliers
# ---------------------------------------------------------------------------

# Maps a parsed size_modifier string to a serving-scale multiplier relative
# to the default/medium serving returned by USDA or the fallback rules.
# "medium" / "regular" are the baseline (1.0×).  Starbucks sizes use the
# 12-oz Tall as baseline so Grande (16 oz) ≈ 1.33×, Venti (20 oz) ≈ 1.67×
# — rounded to clean values that absorb the real-world calorie variance.
_SIZE_MULTIPLIERS: dict[str, float] = {
    "mini":         0.60,
    "small":        0.75,
    "tall":         1.00,   # Starbucks small (12 oz) — used as baseline
    "medium":       1.00,
    "regular":      1.00,
    "large":        1.35,
    "grande":       1.15,   # Starbucks medium (16 oz)
    "venti":        1.50,   # Starbucks large  (20 oz)
    "jumbo":        1.60,
    "extra large":  1.60,
    "extra-large":  1.60,
    "king size":    1.50,
    "king-size":    1.50,
}


def get_nutrition(
    query: str,
    *,
    quantity: float = 0.0,
    unit: str | None = None,
    size_modifier: str | None = None,
    prefer_generic: bool = False,
    rule_based_only: bool = False,
) -> dict:
    """
    Public entry point called by the router and composite service.

    Fetches single-serving nutrition via _fetch_nutrition, then scales all
    macros by an effective multiplier derived from quantity × size_modifier.

    quantity keyword argument (Phase 2)
    ────────────────────────────────────
    When the caller provides a pre-parsed quantity > 0 (e.g. from the Phase 1
    ParsedQuery), that value is used directly.  This enables decimal quantities
    ("2.5 cups rice" → 2.5) and number words ("half" → 0.5) that the legacy
    integer extractor below cannot produce.

    When quantity is 0.0 (default), the legacy _extract_leading_quantity()
    is used on the raw query text for backward compatibility with callers
    (COMPOSITE_MEAL, AMBIGUOUS) that still pass the full query.

    size_modifier keyword argument (Phase 4)
    ─────────────────────────────────────────
    When a size word is provided (e.g. "large", "small", "venti"), the result
    is further scaled by the corresponding multiplier in _SIZE_MULTIPLIERS.
    The size multiplier is applied after — and multiplied with — the quantity
    scale factor, so "2 large lattes" uses effective_qty = 2 × 1.35 = 2.70.
    Unrecognised size words default to 1.0× (no change).

    prefer_generic keyword argument
    ────────────────────────────────
    When True, restricts the USDA query to Foundation / SR Legacy / Survey
    data types, excluding manufacturer-submitted Branded entries.  Pass this
    for GENERIC_FOOD queries where branded product names ("Chicken Breast")
    crowd out the scientific database entries in USDA's text-search ranking.
    Defaults to False so fallback paths from branded/restaurant routing are
    unaffected.

    rule_based_only keyword argument
    ─────────────────────────────────
    When True, skip the USDA HTTP fetch entirely and return the rule-based
    estimate directly.  Use this for BRANDED_PACKAGED / RESTAURANT_ITEM miss
    paths where the primary source (OFF) failed and USDA data would be either
    per-100g for a different product (e.g. SR Legacy candy entry for a specific
    brand miss) or otherwise misleading.  The rule-based result is always
    tagged `is_estimated=True`.

    Always stamps a "name" field so every response carries the full shape
    expected by POST /logs.  The caller (router) may override "name" afterward
    with the original user-facing text if desired.
    """
    qty       = quantity if quantity > 0.0 else float(_extract_leading_quantity(query))
    profile   = _profile_for_query(query) if prefer_generic else None
    size_key  = size_modifier.lower() if size_modifier else None
    size_mult = _SIZE_MULTIPLIERS.get(size_key, 1.0) if size_key else 1.0
    eff_qty   = qty * size_mult

    if rule_based_only:
        result = {**_get_fallback_nutrition(_normalize_query(query) or query), "is_estimated": True}
    else:
        result = _fetch_nutrition(query, prefer_generic=prefer_generic)

    # Normalize the query for display: strips leading counts and size words.
    result["name"] = _normalize_query(query) or query.strip()

    if profile is not None and not result.get("is_estimated", True):
        grams = _grams_from_unit(unit, qty, profile) if unit else None
        serving_label = None
        if grams is None:
            if size_key and size_key in profile.unit_grams:
                grams = qty * profile.unit_grams[size_key]
                serving_label = f"{qty:g} {size_key}"
            else:
                grams = profile.default_grams * eff_qty
        elif unit:
            serving_label = f"{qty:g} {unit}"

        scale = grams / 100.0
        result["serving_description"] = (
            serving_label or f"{grams:g} g serving"
        )
        return {
            **result,
            "calories": round(result["calories"] * scale, 1),
            "protein":  round(result["protein"]  * scale, 1),
            "carbs":    round(result["carbs"]    * scale, 1),
            "fat":      round(result["fat"]      * scale, 1),
        }

    if eff_qty != 1.0:
        return {
            **result,
            "calories": round(result["calories"] * eff_qty, 1),
            "protein":  round(result["protein"]  * eff_qty, 1),
            "carbs":    round(result["carbs"]     * eff_qty, 1),
            "fat":      round(result["fat"]       * eff_qty, 1),
        }
    return result
