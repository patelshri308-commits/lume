"""
Nutrition engine — live API integration tests.

These tests call real external services (USDA FoodData Central and Open Food
Facts).  They are intentionally excluded from the default pytest run because:

  • They are slow      (~1–8 s each due to network round-trips)
  • They are flaky     (remote APIs can time out or return stale data)
  • They cost quota    (USDA DEMO_KEY allows 30 req/hour; a free key raises this)

Opt in explicitly:
    cd backend && pytest tests/test_nutrition_live.py -v -m live

Or run everything including live:
    cd backend && pytest -m "live" -v

What each test proves end-to-end
─────────────────────────────────
These tests validate the full pipeline from raw query → HTTP → scoring →
result.  The unit tests in test_nutrition_unit.py verify internal logic with
mocks; these tests verify that the mocked behaviour matches reality.

Stability notes (see test docstrings for per-test details)
───────────────────────────────────────────────────────────
• OFF-dependent tests (hershey bar, mcdonalds fries) may fail if the OFF
  database entry changes or if the entry lacks per-serving nutrition data.
• USDA-dependent tests (chicken breast, 2.5 cups rice) are stable — USDA
  Foundation data rarely changes.
• banana smoothie relies on the meal-calorie floor which is internal, so the
  only external dependency is whether the USDA search returns a result at all.
"""
from __future__ import annotations

import pytest

from app.services.query_router import route_food_query


# ============================================================
# Helpers
# ============================================================

def _assert_macros_positive(result: dict, query: str) -> None:
    """All macros must be non-negative (negative is always a bug)."""
    for key in ("calories", "protein", "carbs", "fat"):
        assert result[key] >= 0, f"[{query}] {key}={result[key]} is negative"


def _assert_required_keys(result: dict, query: str) -> None:
    required = {"name", "calories", "protein", "carbs", "fat",
                "is_estimated", "source_type", "confidence"}
    missing = required - result.keys()
    assert not missing, f"[{query}] result is missing keys: {missing}"


# ============================================================
# Live tests
# ============================================================

@pytest.mark.live
def test_live_hershey_bar():
    """
    'hershey bar' should hit Open Food Facts and return a standard chocolate
    bar — NOT the syrup, NOT the miniatures, NOT the baking cocoa.

    Flaky surface: OFF database content.  If the Hershey's Milk Chocolate
    Bar entry is removed or its nutrition data is missing, this will fall back
    to 'packaged_guess'.  The calorie range 150–350 still holds in that case
    (rule-based candy estimate ≈ 200 cal).
    """
    result = route_food_query("hershey bar")
    _assert_required_keys(result, "hershey bar")
    _assert_macros_positive(result, "hershey bar")

    assert result["source_type"] in ("packaged_product", "packaged_guess"), (
        f"source_type={result['source_type']!r}; 'hershey bar' must never route "
        "to USDA (it has no branded product data)."
    )
    assert 150 < result["calories"] < 350, (
        f"calories={result['calories']}; a standard Hershey bar is ~210 cal. "
        "This range is intentionally wide to tolerate per-serving vs per-100g variation."
    )
    assert result["confidence"] > 0.30, (
        f"confidence={result['confidence']}; even a fallback should exceed 0.30"
    )


@pytest.mark.live
def test_live_hershey_syrup():
    """
    'hershey syrup' should also go to Open Food Facts but return syrup
    nutrition — much higher in carbs/sugar, lower in fat than the solid bar.

    Flaky surface: OFF may lack per-serving data for the syrup; calories
    may vary by product size in the database.
    """
    result = route_food_query("hershey syrup")
    _assert_required_keys(result, "hershey syrup")
    _assert_macros_positive(result, "hershey syrup")

    assert result["source_type"] in ("packaged_product", "packaged_guess")
    # Syrup is typically 50–80 cal / 2 tbsp serving (per-serving) or
    # ~280 cal per 100 g (per-100g).  We accept a wide range.
    assert 30 < result["calories"] < 500, (
        f"calories={result['calories']}; outside plausible range for chocolate syrup"
    )


@pytest.mark.live
def test_live_banana_smoothie_not_plain_banana():
    """
    'banana smoothie' must NOT return plain banana nutrition (~89 cal).
    The meal-calorie floor rejects any USDA result below 150 cal when the
    query contains 'smoothie', and the fallback estimate is 300 cal.

    This test is stable because the floor is internal — it does not depend on
    which USDA record is returned, only on the calorie value of that record.
    """
    result = route_food_query("banana smoothie")
    _assert_required_keys(result, "banana smoothie")
    _assert_macros_positive(result, "banana smoothie")

    assert result["calories"] >= 150, (
        f"calories={result['calories']}; banana smoothie must be ≥ 150 cal. "
        "A plain banana is ~89 cal — if this fails, the meal-calorie floor "
        "is not applying for the 'smoothie' keyword."
    )


@pytest.mark.live
def test_live_coffee_with_milk_has_nonzero_calories():
    """
    'coffee with milk' must produce more calories than black coffee (≈0).
    The composite service splits it into coffee + milk and sums the macros.

    Stable: USDA has reliable Foundation data for both coffee and milk.
    """
    result = route_food_query("coffee with milk")
    _assert_required_keys(result, "coffee with milk")
    _assert_macros_positive(result, "coffee with milk")

    assert result["source_type"] == "composite_meal", (
        f"source_type={result['source_type']!r}; if this is not 'composite_meal' "
        "then 'with milk' was dropped and the result is for black coffee only."
    )
    assert result["calories"] > 10, (
        f"calories={result['calories']}; composite meal with milk should exceed "
        "black coffee.  A typical 'coffee with splash of milk' is 20–80 cal."
    )


@pytest.mark.live
def test_live_large_fries_more_calories_than_plain():
    """
    'large fries' must return more calories than 'fries' (no size modifier).
    The 1.35× size multiplier is applied by the nutrition service after USDA lookup.

    Stable unless USDA returns a very different record for the two queries
    (the normaliser strips 'large' before searching, so both use the same
    USDA candidate; scaling is internal).
    """
    plain = route_food_query("fries")
    large = route_food_query("large fries")

    _assert_macros_positive(large, "large fries")

    assert large["calories"] > plain["calories"], (
        f"large={large['calories']}, plain={plain['calories']}; "
        "'large fries' should always exceed plain fries after the 1.35× multiplier."
    )


@pytest.mark.live
def test_live_rice_quantity_scaling():
    """
    '2.5 cups rice' should return approximately 2.5× the calories of
    a single-serving rice lookup.

    Stable: USDA has reliable Foundation/SR Legacy data for cooked rice.
    """
    from app.services.nutrition_service import get_nutrition

    single  = get_nutrition("rice", quantity=1.0)
    scaled  = get_nutrition("rice", quantity=2.5)

    assert scaled["calories"] == pytest.approx(single["calories"] * 2.5, rel=0.02), (
        f"scaled={scaled['calories']}, single={single['calories']}; "
        "expected scaled ≈ single × 2.5"
    )


@pytest.mark.live
def test_live_yogurt_with_granola_composite():
    """
    'yogurt with granola' must be a composite_meal and its calories should
    exceed yogurt alone (granola adds ~200 cal per cup).

    Flaky surface: the granola USDA lookup might return a very high-calorie
    granola entry.  The 'more than yogurt alone' assertion is robust because
    granola is always calorie-dense.
    """
    from app.services.nutrition_service import get_nutrition

    yogurt_only = get_nutrition("yogurt")
    composite   = route_food_query("yogurt with granola")

    _assert_required_keys(composite, "yogurt with granola")
    assert composite["source_type"] == "composite_meal"
    assert composite["calories"] > yogurt_only["calories"], (
        f"composite={composite['calories']}, yogurt_only={yogurt_only['calories']}; "
        "adding granola should always increase total calories."
    )


@pytest.mark.live
def test_live_chicken_breast_usda_confident():
    """
    'chicken breast' should resolve via USDA Foundation data with high
    confidence.  Typical cooked chicken breast is 140–200 cal per serving.

    Stable: USDA Foundation has authoritative whole-food data for chicken.
    """
    result = route_food_query("chicken breast")
    _assert_required_keys(result, "chicken breast")
    _assert_macros_positive(result, "chicken breast")

    assert result["confidence"] >= 0.70, (
        f"confidence={result['confidence']}; USDA Foundation chicken data "
        "should produce high confidence (≥ 0.70)."
    )
    assert 100 < result["calories"] < 300, (
        f"calories={result['calories']}; typical cooked chicken breast serving "
        "is 140–200 cal."
    )
    # Chicken breast is high-protein — a sanity check that macros are reasonable
    assert result["protein"] > 20, (
        f"protein={result['protein']}; chicken breast should be >20 g protein per serving"
    )


@pytest.mark.live
def test_live_mcdonalds_fries_routes_to_restaurant():
    """
    'mcdonalds fries' must hit Open Food Facts (restaurant service),
    not USDA.  Calories for medium McDonald's fries are ~320 cal.

    Flaky surface: OFF data for McDonald's varies by region and update
    frequency.  The calorie range 150–600 is intentionally broad.
    """
    result = route_food_query("mcdonalds fries")
    _assert_required_keys(result, "mcdonalds fries")
    _assert_macros_positive(result, "mcdonalds fries")

    assert result["source_type"] in ("restaurant", "restaurant_guess"), (
        f"source_type={result['source_type']!r}; 'mcdonalds fries' must never "
        "hit USDA as the primary source."
    )
    assert 150 < result["calories"] < 600, (
        f"calories={result['calories']}; McDonald's fries range from "
        "~220 cal (small) to ~490 cal (large)."
    )


@pytest.mark.live
def test_live_all_results_have_required_shape():
    """
    Smoke test: every benchmark query must return a dict with the canonical
    nutrition shape consumed by the frontend.

    If any key is missing, the mobile app will crash on the result screen.
    """
    queries = [
        "hershey bar",
        "hershey syrup",
        "banana smoothie",
        "coffee with milk",
        "large fries",
        "2.5 cups rice",
        "yogurt with granola",
        "chicken breast",
        "mcdonalds fries",
    ]
    required = {"name", "calories", "protein", "carbs", "fat",
                "is_estimated", "source_type", "confidence"}

    for q in queries:
        result = route_food_query(q)
        missing = required - result.keys()
        assert not missing, f"Query {q!r} result missing keys: {missing}"
        # confidence must be a float in [0, 1]
        assert 0.0 <= result["confidence"] <= 1.0, (
            f"Query {q!r}: confidence={result['confidence']} out of range"
        )
