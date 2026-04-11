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
    score = 0
    description = food.get("description", "").lower()
    data_type    = food.get("dataType", "Branded")

    # Reward generic data types, penalise branded ones
    score += DATA_TYPE_SCORE.get(data_type, -30)

    # Reward every query word that appears in the description
    for word in query.lower().split():
        if word in description:
            score += 15

    # Penalise descriptions that contain processed-food keywords
    for keyword in PROCESSED_KEYWORDS:
        if keyword in description:
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


def _get_fallback_nutrition(query: str) -> dict:
    """Rule-based fallback used when the USDA API is unavailable or returns nothing."""
    q = query.lower()

    if "apple" in q:
        return {"calories": 95,  "protein": 0,  "carbs": 25, "fat": 0,  "matched_food": "fallback"}
    elif "banana" in q:
        return {"calories": 89,  "protein": 1,  "carbs": 23, "fat": 0,  "matched_food": "fallback"}
    elif "burger" in q or "pizza" in q:
        return {"calories": 650, "protein": 30, "carbs": 55, "fat": 35, "matched_food": "fallback"}
    else:
        return {"calories": 250, "protein": 10, "carbs": 20, "fat": 15, "matched_food": "fallback"}


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
            return _get_fallback_nutrition(query)

        # Pick the highest-scoring result instead of blindly taking foods[0]
        best_food = max(foods, key=lambda food: _score_food(food, query))

        # Temporary debug field — lets you see exactly which USDA item was chosen.
        # Remove this once you are confident the selection logic is working well.
        selected_description = best_food.get("description", "unknown")

        nutrients = best_food.get("foodNutrients", [])

        return {
            "calories":     _extract_nutrient(nutrients, NUTRIENT_ID_CALORIES),
            "protein":      _extract_nutrient(nutrients, NUTRIENT_ID_PROTEIN),
            "carbs":        _extract_nutrient(nutrients, NUTRIENT_ID_CARBS),
            "fat":          _extract_nutrient(nutrients, NUTRIENT_ID_FAT),
            "matched_food": selected_description,   # <-- debug: remove when done
        }

    except Exception:
        return _get_fallback_nutrition(query)
