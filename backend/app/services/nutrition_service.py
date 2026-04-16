import os
import httpx

# ---------------------------------------------------------------------------
# USDA FoodData Central API
# Get a free key at: https://fdc.nal.usda.gov/api-key-signup.html
# "DEMO_KEY" works without signing up but is limited to 30 requests/hour.
# ---------------------------------------------------------------------------
USDA_API_KEY    = os.getenv("USDA_API_KEY", "DEMO_KEY")
USDA_SEARCH_URL = "https://api.nal.usda.gov/fdc/v1/foods/search"

# USDA identifies each nutrient by a fixed numeric ID.
NUTRIENT_ID_CALORIES = 1008  # Energy (kcal)
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


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _score_food(food: dict, query: str) -> int:
    """
    Assign a score to a USDA result. Higher score = better match for a generic query.
    This is used to pick the best result from a list of candidates.
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
    for word in query_words:
        stem = word[:-1] if len(word) > 3 and word.endswith("s") else word
        if word in description or stem in description:
            score += 15

    # Penalise descriptions that contain processed-food keywords —
    # but only when those keywords were NOT part of the user's query.
    # Without this guard, searching "orange juice" or "banana bread"
    # would penalise the best matching results.
    for keyword in PROCESSED_KEYWORDS:
        if keyword in description and keyword not in query_words:
            score -= 20

    # Shorter descriptions tend to be plainer foods ("Bananas, raw" beats
    # "Banana cream pie filling, canned, ready to serve").
    score -= len(description) // 10

    return score


def _extract_nutrient(nutrients: list, nutrient_id: int) -> float:
    """Find a nutrient value by its ID inside a USDA food's nutrient list."""
    for nutrient in nutrients:
        if nutrient.get("nutrientId") == nutrient_id:
            return round(nutrient.get("value", 0), 1)
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

    # Remove "with ..." add-on phrases — keep only the core food
    if " with " in q:
        q = q[:q.index(" with ")].strip()

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

def _fetch_nutrition(query: str) -> dict:
    """
    Fetch single-serving nutrition data from USDA FoodData Central.
    Scores the candidates and picks the best generic match.
    Falls back to rule-based estimates if the API fails or returns no results.
    """
    query = _normalize_query(query)

    try:
        response = httpx.get(
            USDA_SEARCH_URL,
            params={
                "query":    query,
                "api_key":  USDA_API_KEY,
                "pageSize": 10,   # Fetch a pool of candidates so we can rank them
            },
            timeout=5.0,
        )
        response.raise_for_status()

        foods = response.json().get("foods", [])

        if not foods:
            return {**_get_fallback_nutrition(query), "is_estimated": True}

        # Pick the highest-scoring result instead of blindly taking foods[0]
        best_food  = max(foods, key=lambda food: _score_food(food, query))
        best_score = _score_food(best_food, query)

        # Reject weak matches: if even the best candidate didn't earn enough
        # score to clear the threshold, no query word appeared in any result —
        # returning it would be misleading.
        if best_score < CONFIDENCE_THRESHOLD:
            return {**_get_fallback_nutrition(query), "is_estimated": True}

        nutrients = best_food.get("foodNutrients", [])
        calories  = _extract_nutrient(nutrients, NUTRIENT_ID_CALORIES)

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
        for keyword, floor in _MEAL_CALORIE_FLOOR.items():
            if keyword in query and calories < floor:
                return {**_get_fallback_nutrition(query), "is_estimated": True}

        return {
            "calories":     calories,
            "protein":      _extract_nutrient(nutrients, NUTRIENT_ID_PROTEIN),
            "carbs":        _extract_nutrient(nutrients, NUTRIENT_ID_CARBS),
            "fat":          _extract_nutrient(nutrients, NUTRIENT_ID_FAT),
            "is_estimated": False,
        }

    except Exception:
        return {**_get_fallback_nutrition(query), "is_estimated": True}


def get_nutrition(query: str) -> dict:
    """
    Public entry point called by the router.
    Extracts a leading quantity (e.g. "2 donuts" → qty=2), fetches a
    single-serving result via _fetch_nutrition, then scales all macros
    if qty > 1.  Quantity detection happens on the raw query before
    normalization strips the number.

    Always stamps a "name" field (normalized query) so every response
    from this service carries the full shape expected by POST /logs.
    """
    qty    = _extract_leading_quantity(query)
    result = _fetch_nutrition(query)

    # Normalize the query for display: strips leading counts, size words,
    # and "with ..." add-ons so the stored name is clean.
    result["name"] = _normalize_query(query) or query.strip()

    if qty > 1:
        return {
            **result,
            "calories": round(result["calories"] * qty, 1),
            "protein":  round(result["protein"]  * qty, 1),
            "carbs":    round(result["carbs"]     * qty, 1),
            "fat":      round(result["fat"]       * qty, 1),
        }
    return result
