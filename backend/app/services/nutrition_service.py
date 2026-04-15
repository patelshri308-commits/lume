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
    if "coffee" in q:
        return {"calories": 50,  "protein": 1,  "carbs": 8,  "fat": 2}
    if "orange juice" in q:
        return {"calories": 110, "protein": 2,  "carbs": 26, "fat": 0}
    if "juice" in q:
        return {"calories": 120, "protein": 1,  "carbs": 28, "fat": 0}
    if "soda" in q or "cola" in q:
        return {"calories": 150, "protein": 0,  "carbs": 40, "fat": 0}
    if "lemonade" in q:
        return {"calories": 150, "protein": 0,  "carbs": 38, "fat": 0}
    if "sports drink" in q or "gatorade" in q or "powerade" in q:
        return {"calories": 100, "protein": 0,  "carbs": 25, "fat": 0}
    if "energy drink" in q or "red bull" in q or "monster" in q:
        return {"calories": 150, "protein": 1,  "carbs": 35, "fat": 0}
    if "iced tea" in q:                              # must precede "tea" check
        return {"calories": 100, "protein": 0,  "carbs": 25, "fat": 0}
    if "tea" in q:
        return {"calories": 0,   "protein": 0,  "carbs": 0,  "fat": 0}

    # ── Generic fallback ──────────────────────────────────────────────────────
    return {"calories": 250, "protein": 10, "carbs": 20, "fat": 15}


# ---------------------------------------------------------------------------
# Public function — called by the router
# ---------------------------------------------------------------------------

def get_nutrition(query: str) -> dict:
    """
    Fetch nutrition data for a food query from the USDA FoodData Central API.
    Scores the candidates and picks the best generic match.
    Falls back to rule-based estimates if the API fails or returns no results.
    """
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

        return {
            "calories":     _extract_nutrient(nutrients, NUTRIENT_ID_CALORIES),
            "protein":      _extract_nutrient(nutrients, NUTRIENT_ID_PROTEIN),
            "carbs":        _extract_nutrient(nutrients, NUTRIENT_ID_CARBS),
            "fat":          _extract_nutrient(nutrients, NUTRIENT_ID_FAT),
            "is_estimated": False,
        }

    except Exception:
        return {**_get_fallback_nutrition(query), "is_estimated": True}
