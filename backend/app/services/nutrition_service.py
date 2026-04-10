def get_mock_nutrition(query: str) -> dict:
    """
    Returns mock nutrition data based on the food query.
    This will be replaced with a real API call (e.g. USDA) in a later phase.
    """
    q = query.lower()

    if "apple" in q:
        return {"calories": 95, "protein": 0, "carbs": 25, "fat": 0}
    elif "banana" in q:
        return {"calories": 89, "protein": 1, "carbs": 23, "fat": 0}
    elif "burger" in q or "pizza" in q:
        return {"calories": 650, "protein": 30, "carbs": 55, "fat": 35}
    else:
        return {"calories": 250, "protein": 10, "carbs": 20, "fat": 15}
