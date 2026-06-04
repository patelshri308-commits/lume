"""
Nutrition engine — fast regression tests.

These tests run entirely offline (no USDA, no Open Food Facts).  They are
split into three sections:

  Section 1 — Classification
    Verifies that each benchmark query is routed to the correct QueryClass
    before any API call is made.  A classification bug is the cheapest kind
    to catch: it propagates into every downstream result.

  Section 2 — Candidate scoring
    Verifies that the scorer ranks correct product variants above wrong ones
    for the same brand query.  These are pure-function tests with no mocking.

  Section 3 — Nutrition logic (mocked)
    Tests the nutrition service's internal logic — size multipliers, quantity
    scaling, meal-calorie floors, and composite-meal decomposition — by
    patching the USDA HTTP call so nothing leaves the machine.

Run:
    cd backend && pytest tests/test_nutrition_unit.py -v
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services.candidate_scorer import score_candidate
from app.services.nutrition_service import _fetch_nutrition, _profile_for_query, get_nutrition
from app.services.query_classifier import QueryClass, classify
from app.services.query_parser import parse
from app.services.query_router import route_food_query


# ============================================================
# Shared mock data
# ============================================================

# A generic single-serving nutrition dict returned by _fetch_nutrition when
# mocked.  Represents a plain 200-calorie food with round macros.
_MOCK_SINGLE = {
    "calories":     200.0,
    "protein":      10.0,
    "carbs":        25.0,
    "fat":           8.0,
    "is_estimated": False,
    "source_name":  "Test Food, plain",
}

# Minimal packaged product dict that search_packaged_product would return.
# _internal_score drives the confidence tier in the router.
def _mock_packaged(name: str, calories: int, score: int = 75) -> dict:
    return {
        "name":                name,
        "calories":            calories,
        "protein":             5.0,
        "carbs":               28.0,
        "fat":                 11.0,
        "is_estimated":        False,
        "source_type":         "packaged_product",
        "source_name":         "Open Food Facts",
        "brand_name":          "Hershey's",
        "serving_description": "43g",
        "_internal_score":     score,
    }

def _mock_restaurant(name: str, calories: int, score: int = 60) -> dict:
    return {
        "name":                name,
        "calories":            calories,
        "protein":             4.0,
        "carbs":               40.0,
        "fat":                 15.0,
        "is_estimated":        False,
        "source_type":         "restaurant",
        "source_name":         "Open Food Facts",
        "brand_name":          "McDonald's",
        "serving_description": "medium",
        "_internal_score":     score,
    }

# Simulated USDA response payload — used to test the HTTP layer without
# actually calling the USDA API.
def _usda_response(description: str, data_type: str, calories: float,
                   protein: float = 5.0, carbs: float = 20.0, fat: float = 5.0) -> MagicMock:
    """Return a mock httpx.Response whose .json() yields a single USDA food."""
    payload = {
        "foods": [{
            "description":   description,
            "dataType":      data_type,
            "foodNutrients": [
                {"nutrientId": 1008, "value": calories},
                {"nutrientId": 1003, "value": protein},
                {"nutrientId": 1005, "value": carbs},
                {"nutrientId": 1004, "value": fat},
            ],
        }]
    }
    mock_resp = MagicMock()
    mock_resp.json.return_value = payload
    mock_resp.raise_for_status.return_value = None
    return mock_resp


def _usda_multi_response(*foods: tuple[str, str, float, float, float, float]) -> MagicMock:
    """Return a mock USDA response with multiple candidate foods."""
    payload = {"foods": []}
    for description, data_type, calories, protein, carbs, fat in foods:
        payload["foods"].append({
            "description": description,
            "dataType": data_type,
            "foodNutrients": [
                {"nutrientId": 1008, "value": calories},
                {"nutrientId": 1003, "value": protein},
                {"nutrientId": 1005, "value": carbs},
                {"nutrientId": 1004, "value": fat},
            ],
        })
    mock_resp = MagicMock()
    mock_resp.json.return_value = payload
    mock_resp.raise_for_status.return_value = None
    return mock_resp


# ============================================================
# Section 1: Classification
# ============================================================

class TestClassification:
    """
    Each query must land in the correct QueryClass.

    Classification happens before any API call, so these tests are instant
    and deterministic.  A regression here means the wrong source service
    would be called (e.g. USDA instead of Open Food Facts for a branded item).
    """

    @pytest.mark.parametrize("query, expected", [
        # Branded packaged goods — must go to Open Food Facts, not USDA.
        # Before Phase 1, 'hershey' was absent from _PACKAGED_SIGNALS so
        # both queries incorrectly hit USDA and returned wrong nutrition.
        ("hershey bar",        QueryClass.BRANDED_PACKAGED),
        ("hershey syrup",      QueryClass.BRANDED_PACKAGED),

        # Composite meals — 'with' add-ins must never be dropped.
        # If these were classified GENERIC_FOOD the 'milk' or 'granola' context
        # would be silently discarded, returning only the base food's calories.
        ("coffee with milk",   QueryClass.COMPOSITE_MEAL),
        ("yogurt with granola", QueryClass.COMPOSITE_MEAL),

        # Restaurant chain — must never route to USDA first.
        ("mcdonalds fries",    QueryClass.RESTAURANT_ITEM),

        # Generic whole foods — should stay on the USDA/Foundation path.
        ("chicken breast",     QueryClass.GENERIC_FOOD),
        ("large fries",        QueryClass.GENERIC_FOOD),
        ("2.5 cups rice",      QueryClass.GENERIC_FOOD),

        # 'banana smoothie' is two words but only 'smoothie' is ambiguous,
        # so the classifier correctly falls through to GENERIC_FOOD.
        ("banana smoothie",    QueryClass.GENERIC_FOOD),

        # Lume treats plain cooked pasta as a generic benchmark food.
        ("pasta",              QueryClass.GENERIC_FOOD),
    ])
    def test_query_routes_to_correct_class(self, query: str, expected: QueryClass):
        parsed = parse(query)
        got    = classify(parsed)
        assert got == expected, (
            f"Query {query!r} should be {expected.value} but got {got.value}. "
            f"core_food={parsed.core_food!r}, with_components={parsed.with_components}"
        )

    def test_coffee_with_milk_preserves_milk_component(self):
        """Parser must extract 'milk' as a with_component, not discard it."""
        parsed = parse("coffee with milk")
        assert "milk" in parsed.with_components, (
            "Parser dropped the 'milk' component from 'coffee with milk'. "
            "This will cause the router to return black-coffee (0 cal) nutrition."
        )

    def test_yogurt_with_granola_preserves_granola(self):
        """'granola' must survive parsing as a with_component."""
        parsed = parse("yogurt with granola")
        assert "granola" in parsed.with_components

    def test_large_fries_extracts_size_modifier(self):
        """Parser must capture 'large' so the size multiplier (1.35×) is applied."""
        parsed = parse("large fries")
        assert parsed.size_modifier == "large", (
            f"size_modifier={parsed.size_modifier!r}; 'large' was not extracted. "
            "Without it, 'large fries' returns medium-sized nutrition."
        )

    def test_rice_quantity_extracted_as_float(self):
        """'2.5 cups rice' must carry quantity=2.5 so macro scaling works."""
        parsed = parse("2.5 cups rice")
        assert parsed.quantity == pytest.approx(2.5), (
            f"quantity={parsed.quantity}; expected 2.5. "
            "Fractional quantities are a known edge-case for the legacy integer extractor."
        )
        assert parsed.unit == "cups"
        assert parsed.core_food == "rice"

    def test_compact_gram_quantity_is_parsed(self):
        """'100g chicken breast' should parse as a gram measurement."""
        parsed = parse("100g chicken breast")
        assert parsed.quantity == pytest.approx(100.0)
        assert parsed.unit == "g"
        assert parsed.core_food == "chicken breast"


# ============================================================
# Section 2: Candidate scoring
# ============================================================

class TestCandidateScoring:
    """
    The scorer must surface the canonical product form above wrong variants
    for the same brand.  These tests are pure-function: no mocking needed.

    Protects against:
      - Hershey syrup winning for a 'hershey bar' query
      - Hershey miniatures winning because of scan popularity
      - Quest cookie dough beating birthday cake for a birthday-cake query
      - Explicit variant queries still routing to the right product
    """

    def test_hershey_bar_beats_syrup(self):
        """Syrup must never win for a plain 'hershey bar' query."""
        bar   = score_candidate("Hershey's Milk Chocolate Bar", "Hershey's", "hershey bar")
        syrup = score_candidate("Hershey's Chocolate Syrup",    "Hershey's", "hershey bar")
        assert bar > syrup, f"bar={bar} should exceed syrup={syrup}"

    def test_hershey_bar_beats_miniatures(self):
        """Miniatures must not win for a plain 'hershey bar' query."""
        bar   = score_candidate("Hershey's Milk Chocolate Bar", "Hershey's", "hershey bar")
        minis = score_candidate("Hershey's Miniatures",         "Hershey's", "hershey bar")
        assert bar > minis, f"bar={bar} should exceed minis={minis}"

    def test_hershey_bar_beats_baking_cocoa(self):
        """Baking cocoa must not win for 'hershey bar' — it is a different product form."""
        bar   = score_candidate("Hershey's Milk Chocolate Bar",   "Hershey's", "hershey bar")
        cocoa = score_candidate("Hershey's Natural Unsweetened Cocoa", "Hershey's", "hershey bar")
        assert bar > cocoa, f"bar={bar} should exceed cocoa={cocoa}"

    def test_hershey_syrup_wins_for_syrup_query(self):
        """When the user explicitly asks for syrup, the syrup product wins."""
        syrup = score_candidate("Hershey's Chocolate Syrup",    "Hershey's", "hershey syrup")
        bar   = score_candidate("Hershey's Milk Chocolate Bar", "Hershey's", "hershey syrup")
        assert syrup > bar, (
            "When a user types 'hershey syrup', the syrup product should rank above "
            "the bar — the variant mismatch penalty must only fire for absent terms."
        )

    def test_quest_birthday_cake_beats_cookie_dough(self):
        """Scorer must pick the birthday-cake variant, not the most popular one."""
        birthday = score_candidate(
            "Quest Birthday Cake Protein Bar", "Quest Nutrition",
            "quest birthday cake bar"
        )
        cookie = score_candidate(
            "Quest Chocolate Chip Cookie Dough Bar", "Quest Nutrition",
            "quest birthday cake bar"
        )
        assert birthday > cookie, f"birthday={birthday} should exceed cookie={cookie}"

    def test_exact_name_match_scores_highest(self):
        """A product whose name exactly equals the query gets the highest score."""
        exact   = score_candidate("Hershey Bar",              "Hershey's", "hershey bar")
        partial = score_candidate("Hershey's Cookies 'n' Creme Bar", "Hershey's", "hershey bar")
        assert exact > partial, f"exact={exact} should exceed partial={partial}"

    def test_variety_pack_penalised(self):
        """Variety packs must score below a plain single-item product."""
        plain   = score_candidate("Hershey's Milk Chocolate Bar",    "Hershey's", "hershey bar")
        variety = score_candidate("Hershey's Variety Pack Assorted", "Hershey's", "hershey bar")
        assert plain > variety


# ============================================================
# Section 3: Nutrition logic (mocked external calls)
# ============================================================

class TestNutritionLogic:
    """
    Tests for the nutrition service's internal logic — quantity scaling,
    size multipliers, meal-calorie floors, and composite routing.

    All USDA HTTP calls are patched out so these tests run offline.
    """

    # ── Quantity and size scaling ─────────────────────────────────────────────

    def test_large_size_modifier_scales_calories(self):
        """
        'large' size modifier must multiply calories by 1.35× relative to
        a baseline (no size modifier) result for the same food.

        Protects against: size_modifier being silently ignored so every size
        of a drink/food returns identical macros.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("French Fries", "SR Legacy", 300.0)):
            base  = get_nutrition("fries")
            large = get_nutrition("fries", size_modifier="large")

        assert large["calories"] == pytest.approx(base["calories"] * 1.35, rel=0.01), (
            f"large={large['calories']}, base={base['calories']}; "
            "expected large ≈ base × 1.35"
        )

    def test_small_size_modifier_scales_calories(self):
        """'small' must scale to 0.75× relative to baseline."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("French Fries", "SR Legacy", 300.0)):
            base  = get_nutrition("fries")
            small = get_nutrition("fries", size_modifier="small")

        assert small["calories"] == pytest.approx(base["calories"] * 0.75, rel=0.01)

    def test_fractional_quantity_scales_correctly(self):
        """
        A fractional household quantity should convert through the canonical
        serving profile.  Rice defaults to cooked cup semantics, so 2.5 cups
        uses 2.5 × 158 g of cooked rice.

        Protects against: the legacy integer extractor truncating 2.5 → 2
        or 1 when a float quantity is provided by the parser.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Rice, cooked", "SR Legacy", 200.0,
                                               protein=4.0, carbs=44.0, fat=0.5)):
            result = get_nutrition("rice", quantity=2.5, unit="cups", prefer_generic=True)

        scale = (2.5 * 158) / 100
        assert result["calories"] == pytest.approx(200.0 * scale, rel=0.01)
        assert result["protein"]  == pytest.approx(4.0 * scale,   rel=0.01)
        assert result["carbs"]    == pytest.approx(44.0 * scale,  rel=0.01)
        assert result["serving_description"] == "2.5 cups"

    def test_quantity_two_scales_all_macros(self):
        """Ordering 2 of an item should double every macro."""
        # Use salmon (non-verified, default_grams=100) so scale=1.0/2.0 and
        # all values are exact doubles with no floating-point rounding artefacts.
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Fish, salmon, chinook, cooked",
                                               "SR Legacy", 200.0,
                                               protein=20.0, carbs=2.0, fat=12.0)):
            single = get_nutrition("salmon", prefer_generic=True)
            double = get_nutrition("salmon", quantity=2.0, prefer_generic=True)

        for macro in ("calories", "protein", "carbs", "fat"):
            assert double[macro] == pytest.approx(single[macro] * 2, rel=0.01), (
                f"{macro}: single={single[macro]}, double={double[macro]}"
            )

    def test_gram_unit_uses_exact_weight(self):
        """A gram measurement should scale from USDA per-100g data directly."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            result = route_food_query("100g chicken breast")

        assert result["calories"] == pytest.approx(165.0)
        assert result["protein"] == pytest.approx(31.0)
        assert result["serving_description"] == "100 g"

    def test_tablespoon_unit_uses_food_specific_weight(self):
        """Tablespoons must convert to grams instead of multiplying per-100g nutrition."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Peanut butter, creamy", "SR Legacy",
                       632.0, protein=24.0, carbs=22.7, fat=49.4
                   )):
            result = route_food_query("2 tbsp peanut butter")

        scale = 32 / 100
        assert result["calories"] == pytest.approx(632.0 * scale, rel=0.01)
        assert result["serving_description"] == "2 tbsp"

    def test_generic_profile_penalizes_wrong_salmon_form(self):
        """Plain salmon should prefer cooked fish over salmon oil."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Fish oil, salmon", "SR Legacy", 902.0, 0.0, 0.0, 100.0),
                       ("Fish, salmon, Atlantic, cooked", "Foundation", 206.0, 22.1, 0.0, 12.4),
                   )):
            result = route_food_query("salmon")

        assert result["source_name"] == "Fish, salmon, Atlantic, cooked"
        assert result["calories"] == pytest.approx(206.0)

    def test_whole_milk_profile_penalizes_cheese(self):
        """Whole milk should not select adjacent dairy products."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Cheese, ricotta, whole milk", "Foundation", 157.0, 7.8, 6.9, 11.0),
                       ("Milk, buttermilk, fluid, whole", "SR Legacy", 62.0, 3.2, 4.8, 3.3),
                       ("Milk, whole", "Survey (FNDDS)", 61.0, 3.3, 4.6, 3.2),
                   )):
            result = route_food_query("whole milk")

        assert result["source_name"] == "Milk, whole"
        assert result["calories"] == pytest.approx(61.0 * 2.44, rel=0.01)

    def test_almonds_profile_uses_usda_nuts_query(self):
        """Plain almonds should use USDA nut data instead of an estimated fallback."""
        captured_params: list[dict] = []

        def capture_get(url, *, params=None, timeout=None, **kw):
            captured_params.append(dict(params or {}))
            return _usda_multi_response(
                ("Nuts, almond paste", "SR Legacy", 458.0, 9.0, 47.8, 27.7),
                ("Nuts, almonds", "SR Legacy", 579.0, 21.2, 21.6, 49.9),
            )

        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            result = route_food_query("almonds")

        assert captured_params[0]["query"] == "nuts almonds"
        assert result["source_name"] == "Nuts, almonds"
        assert result["is_estimated"] is False
        assert result["calories"] == pytest.approx(579.0 * 0.28, rel=0.01)

    def test_eggs_verified_source_overrides_usda_pool(self):
        """Eggs are in the verified registry — USDA is never called regardless of the pool."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = route_food_query("2 eggs")
        mock_http.assert_not_called()
        assert result["source_name"] == "Eggs, Grade A, Large, egg whole"
        assert result["calories"] == pytest.approx(148.0)

    def test_zero_nutrient_candidate_is_rejected(self):
        """A zero-filled branded candidate must not beat a valid SR Legacy entry."""
        # Salmon is non-verified so the USDA path is exercised here.
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("SALMON", "Branded", 0.0, 0.0, 0.0, 0.0),
                       ("Fish, salmon, chinook, cooked, dry heat", "SR Legacy", 231.0, 25.7, 0.0, 13.4),
                   )):
            result = route_food_query("salmon")

        assert result["source_name"] == "Fish, salmon, chinook, cooked, dry heat"
        assert result["calories"] == pytest.approx(231.0)

    # ── Phase 3: generic food source selection ────────────────────────────────

    def test_pasta_profile_penalizes_gluten_free_corn_pasta(self):
        """Plain pasta should prefer cooked enriched pasta over gluten-free corn pasta."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Pasta, gluten-free, corn, cooked", "Survey (FNDDS)", 175.0, 3.8, 39.1, 1.2),
                       ("Pasta, cooked, enriched, without added salt", "SR Legacy", 157.0, 5.8, 30.9, 0.9),
                   )):
            result = route_food_query("pasta")

        assert result["source_name"] == "Pasta, cooked, enriched, without added salt", (
            f"source_name={result['source_name']!r}; gluten-free corn pasta should be "
            "penalised by the 'gluten-free' avoid_term so plain pasta wins."
        )

    def test_white_rice_verified_bypasses_usda(self):
        """White rice is in the verified registry — USDA is never called."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = route_food_query("white rice")
        mock_http.assert_not_called()
        assert result["source_name"] == "Rice, white, cooked, as ingredient"
        assert result["calories"] == pytest.approx(205.4, rel=0.01)

    def test_olive_oil_profile_penalizes_mixed_oil_blend(self):
        """Olive oil query should prefer pure olive oil over mixed-oil blends."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Oil, corn, peanut, and olive", "SR Legacy", 884.0, 0.0, 0.0, 100.0),
                       ("Oil, olive, salad or cooking", "SR Legacy", 884.0, 0.0, 0.0, 100.0),
                   )):
            result = route_food_query("1 tbsp olive oil")

        assert result["source_name"] == "Oil, olive, salad or cooking", (
            f"source_name={result['source_name']!r}; mixed-oil blend should be "
            "penalised by 'corn'/'peanut' avoid_terms so pure olive oil wins."
        )
        assert result["calories"] == pytest.approx(884.0 * (13.5 / 100), rel=0.01)

    # ── Phase 7A: avoid_term gap fixes ───────────────────────────────────────

    def test_broccoli_profile_penalizes_chinese_broccoli(self):
        """Plain broccoli should prefer regular cooked broccoli over Chinese broccoli (gai lan)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Broccoli, chinese, cooked", "Survey (FNDDS)", 22.0, 2.3, 3.8, 0.7),
                       ("Broccoli, cooked, boiled, drained, without salt", "SR Legacy", 35.0, 2.4, 7.2, 0.4),
                   )):
            result = route_food_query("broccoli")

        assert result["source_name"] == "Broccoli, cooked, boiled, drained, without salt", (
            f"source_name={result['source_name']!r}; Chinese broccoli should be "
            "penalised by the 'chinese' avoid_term so regular cooked broccoli wins."
        )

    def test_oatmeal_profile_penalizes_multigrain(self):
        """Plain oatmeal should prefer plain cooked oatmeal over multigrain oatmeal."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Oatmeal, multigrain", "Survey (FNDDS)", 56.0, 2.1, 12.2, 0.5),
                       ("Oatmeal, regular and quick, cooked with water, without salt", "SR Legacy", 71.0, 2.5, 12.0, 1.4),
                   )):
            result = route_food_query("oatmeal")

        assert result["source_name"] == "Oatmeal, regular and quick, cooked with water, without salt", (
            f"source_name={result['source_name']!r}; multigrain oatmeal should be "
            "penalised by the 'multigrain' avoid_term so plain cooked oatmeal wins."
        )

    def test_ground_beef_profile_penalizes_frozen_patties(self):
        """Ground beef should prefer loose cooked beef over frozen formed patties."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Beef, ground, patties, frozen, cooked, broiled", "Survey (FNDDS)", 295.0, 23.0, 0.0, 21.8),
                       ("Beef, ground, 80% lean meat / 20% fat, cooked, pan-browned", "SR Legacy", 215.0, 24.0, 0.0, 13.0),
                   )):
            result = route_food_query("ground beef")

        assert result["source_name"] == "Beef, ground, 80% lean meat / 20% fat, cooked, pan-browned", (
            f"source_name={result['source_name']!r}; 'patties' (plural) and 'frozen' "
            "must both be caught by avoid_terms so loose cooked ground beef wins."
        )

    def test_sweet_potato_profile_penalizes_frozen(self):
        """Sweet potato should prefer fresh baked over frozen cooked."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Sweet potato, frozen, cooked, baked, with salt", "Survey (FNDDS)", 100.0, 1.7, 23.4, 0.1),
                       ("Sweet potato, cooked, baked in skin, flesh, without salt", "SR Legacy", 86.0, 1.6, 20.1, 0.1),
                   )):
            result = route_food_query("sweet potato")

        assert result["source_name"] == "Sweet potato, cooked, baked in skin, flesh, without salt", (
            f"source_name={result['source_name']!r}; 'frozen' should be penalised "
            "so fresh baked sweet potato wins."
        )

    def test_brown_rice_profile_penalizes_parboiled(self):
        """Brown rice should prefer plain long-grain cooked over parboiled/branded variants."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Rice, brown, parboiled, cooked, UNCLE BENS", "Survey (FNDDS)", 147.0, 3.1, 31.3, 0.8),
                       ("Rice, brown, long-grain, regular, cooked, enriched", "SR Legacy", 123.0, 2.6, 25.6, 0.9),
                   )):
            result = route_food_query("brown rice")

        assert result["source_name"] == "Rice, brown, long-grain, regular, cooked, enriched", (
            f"source_name={result['source_name']!r}; 'parboiled' should be penalised "
            "so plain long-grain brown rice wins."
        )

    def test_pasta_profile_penalizes_homemade_egg_pasta(self):
        """Plain pasta should prefer enriched cooked pasta over homemade egg pasta."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Pasta, homemade, made with egg, cooked", "Survey (FNDDS)", 131.0, 5.3, 23.5, 1.7),
                       ("Pasta, cooked, enriched, without added salt", "SR Legacy", 157.0, 5.8, 30.9, 0.9),
                   )):
            result = route_food_query("pasta")

        assert result["source_name"] == "Pasta, cooked, enriched, without added salt", (
            f"source_name={result['source_name']!r}; 'homemade' should be penalised "
            "so plain enriched pasta wins."
        )

    # ── Phase 7B: broccoli raab fix ───────────────────────────────────────────

    def test_broccoli_profile_penalizes_raab(self):
        """Plain broccoli should prefer regular cooked broccoli over broccoli raab."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Broccoli raab, cooked", "Survey (FNDDS)", 33.0, 3.3, 5.3, 0.4),
                       ("Broccoli, cooked, boiled, drained, without salt", "SR Legacy", 35.0, 2.4, 7.2, 0.4),
                   )):
            result = route_food_query("broccoli")

        assert result["source_name"] == "Broccoli, cooked, boiled, drained, without salt", (
            f"source_name={result['source_name']!r}; 'raab' should be penalised "
            "so plain cooked broccoli wins over broccoli raab."
        )

    # ── Phase 8B: verified-foods pilot ───────────────────────────────────────

    def test_verified_banana_does_not_call_usda(self):
        """Verified banana must return pinned nutrition without any USDA network call."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = get_nutrition("banana", prefer_generic=True)
        mock_http.assert_not_called()
        assert result["is_estimated"] is False
        assert result.get("source_type") == "verified_generic"
        assert result["source_name"] == "Bananas, overripe, raw"

    def test_verified_olive_oil_scales_correctly_for_1_tbsp(self):
        """1 tbsp olive oil (13.5 g) must return ~119.3 kcal from the verified entry."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = get_nutrition("olive oil", quantity=1.0, unit="tbsp", prefer_generic=True)
        mock_http.assert_not_called()
        assert abs(result["calories"] - 119.3) < 0.5, (
            f"Expected ~119.3 kcal for 1 tbsp olive oil, got {result['calories']}"
        )
        assert result.get("source_type") == "verified_generic"

    def test_verified_eggs_scale_correctly_for_2_eggs(self):
        """2 eggs (2 × 50 g = 100 g total) must return ~148.0 kcal from the verified entry."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = get_nutrition("eggs", quantity=2.0, prefer_generic=True)
        mock_http.assert_not_called()
        assert abs(result["calories"] - 148.0) < 0.5, (
            f"Expected ~148.0 kcal for 2 eggs, got {result['calories']}"
        )
        assert result.get("source_type") == "verified_generic"

    def test_non_verified_food_still_calls_usda(self):
        """Foods absent from the verified registry must still use the USDA search path."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Broccoli, cooked, boiled, drained", "SR Legacy", 35.0, 2.4, 7.2, 0.4
                   )) as mock_http:
            result = get_nutrition("broccoli", prefer_generic=True)
        mock_http.assert_called_once()
        assert result.get("source_type") != "verified_generic"

    # ── Meal calorie floor ────────────────────────────────────────────────────

    def test_banana_smoothie_floor_rejects_plain_banana(self):
        """
        If USDA returns 'Bananas, raw' for 'banana smoothie', the meal-
        calorie floor (smoothie ≥ 150 cal) must reject that result and fall
        back to the rule-based smoothie estimate instead.

        This is the canonical 'wrong ingredient beats right meal' failure.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Bananas, raw", "Foundation",
                       calories=89.0, carbs=23.0, fat=0.3, protein=1.1
                   )):
            result = _fetch_nutrition("banana smoothie")

        assert result["is_estimated"] is True, (
            "Expected the meal-calorie floor to reject Bananas (89 cal < 150 floor) "
            "and return an estimated fallback."
        )
        assert result["calories"] >= 150, (
            f"Fallback calories={result['calories']}; smoothie floor is 150 cal."
        )

    def test_smoothie_floor_does_not_fire_for_realistic_smoothie_result(self):
        """
        If USDA returns a plausible smoothie result (≥150 cal), the floor
        must NOT override it with the generic fallback.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Smoothie, banana", "Survey (FNDDS)", calories=220.0
                   )):
            result = _fetch_nutrition("banana smoothie")

        # The floor should pass; result should NOT be estimated
        assert result["is_estimated"] is False
        assert result["calories"] == pytest.approx(220.0, rel=0.01)

    # ── Router-level integration (mocked services) ────────────────────────────

    def test_hershey_bar_router_uses_packaged_service(self):
        """
        route_food_query('hershey bar') must call search_packaged_product,
        not fall through to get_nutrition directly.

        Protects against: a classification regression that routes 'hershey bar'
        back to GENERIC_FOOD, causing USDA to be queried for a branded product.
        """
        mock_result = _mock_packaged("Hershey's Milk Chocolate Bar", calories=210, score=80)
        with patch("app.services.query_router.search_packaged_product",
                   return_value=mock_result) as mock_svc:
            result = route_food_query("hershey bar")

        mock_svc.assert_called_once()
        assert result["source_type"] == "packaged_product"
        assert result["confidence"]  >= 0.75, (
            f"confidence={result['confidence']}; high-score packaged hit should be ≥0.75"
        )
        assert result["calories"]    == 210

    def test_hershey_bar_confidence_reflects_score(self):
        """
        A low-scoring packaged hit (score=20) must return a lower confidence
        than a high-scoring one (score=80), signalling uncertainty to callers.
        """
        high_score_result = _mock_packaged("Hershey's Milk Chocolate Bar", 210, score=80)
        low_score_result  = _mock_packaged("Hershey's something", 210, score=20)

        with patch("app.services.query_router.search_packaged_product",
                   return_value=high_score_result):
            high_conf = route_food_query("hershey bar")["confidence"]

        with patch("app.services.query_router.search_packaged_product",
                   return_value=low_score_result):
            low_conf = route_food_query("hershey bar")["confidence"]

        assert high_conf > low_conf, (
            f"high_conf={high_conf}, low_conf={low_conf}; "
            "higher scorer should produce higher confidence"
        )

    def test_mcdonalds_fries_router_uses_restaurant_service(self):
        """
        route_food_query('mcdonalds fries') must call search_restaurant_item,
        not get_nutrition.  USDA has no McDonald's data.
        """
        mock_result = _mock_restaurant("McDonald's French Fries Medium", calories=320, score=65)
        with patch("app.services.query_router.search_restaurant_item",
                   return_value=mock_result) as mock_svc:
            result = route_food_query("mcdonalds fries")

        mock_svc.assert_called_once()
        assert result["source_type"] == "restaurant"
        assert result["confidence"]  >= 0.55

    def test_chicken_breast_uses_usda_not_off(self):
        """
        'chicken breast' must not touch Open Food Facts — it is a plain whole
        food with reliable USDA Foundation data.
        """
        with patch("app.services.query_router.search_packaged_product") as mock_pkg, \
             patch("app.services.query_router.search_restaurant_item") as mock_rst, \
             patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            result = route_food_query("chicken breast")

        mock_pkg.assert_not_called()
        mock_rst.assert_not_called()
        assert result["source_type"] in ("generic", "usda", "", "verified_generic"), (
            f"source_type={result['source_type']!r}; should not be packaged or restaurant"
        )
        assert result["confidence"] >= 0.80

    def test_coffee_with_milk_is_routed_as_composite(self):
        """
        'coffee with milk' must be handled as a composite meal, meaning both
        coffee and milk are looked up separately and aggregated.

        Protects against: the query being collapsed to just 'coffee', which
        would return 0 calories (black coffee) and silently drop the milk.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Coffee, brewed", "Foundation", 2.0)):
            result = route_food_query("coffee with milk")

        assert result["source_type"] == "composite_meal", (
            f"source_type={result['source_type']!r}; expected 'composite_meal'. "
            "If this is 'generic', the 'with milk' context was dropped."
        )
        # Composite result should be more than plain black coffee (≈ 0–2 cal)
        assert result["calories"] > 2, (
            f"calories={result['calories']}; composite meal including milk "
            "must exceed black-coffee-only nutrition."
        )

    def test_yogurt_with_granola_is_composite(self):
        """'yogurt with granola' must be a composite_meal, not a single-item lookup."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Yogurt, plain", "Foundation", 100.0)):
            result = route_food_query("yogurt with granola")

        assert result["source_type"] == "composite_meal"

    def test_packaged_service_miss_falls_back_gracefully(self):
        """
        When search_packaged_product returns None (OFF miss), the router must
        still return a result — using the USDA/fallback nutrition service.
        The fallback is labelled 'packaged_guess' at lower confidence.
        """
        with patch("app.services.query_router.search_packaged_product", return_value=None), \
             patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Chocolate candy bar", "Branded", 230.0)):
            result = route_food_query("hershey bar")

        assert result is not None
        assert result["source_type"] == "packaged_guess"
        assert result["confidence"]  == pytest.approx(0.35)

    def test_restaurant_service_miss_falls_back_gracefully(self):
        """When search_restaurant_item returns None, the router falls back cleanly."""
        with patch("app.services.query_router.search_restaurant_item", return_value=None), \
             patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("French fries", "SR Legacy", 400.0)):
            result = route_food_query("mcdonalds fries")

        assert result is not None
        assert result["source_type"] == "restaurant_guess"
        assert result["confidence"]  == pytest.approx(0.35)


# ============================================================
# Section 4: GENERIC_FOOD dataType filter (prefer_generic)
# ============================================================

class TestGenericFoodDataTypeFilter:
    """
    Root-cause regression tests for the confidence=0.45 failure on 'chicken breast'.

    Problem
    ───────
    USDA's full-text search ranks by phrase match.  Branded products named
    "Chicken Breast" outrank the Foundation entry "Chicken, broilers …, breast,
    meat only, cooked" because they contain the exact two-word phrase.

    In our internal scorer all Branded items receive DATA_TYPE_SCORE["Branded"]
    = -30, which means even a perfect word match ("chicken" + "breast" + primary
    segment = -30 + 15 + 15 + 10 = 10) falls below CONFIDENCE_THRESHOLD (30).
    When all 10 pool candidates are branded, the best score is ≤ 10, the threshold
    rejects every candidate, and the rule-based fallback runs with is_estimated=True.
    The router then assigns confidence = 0.45 instead of 0.85.

    Fix
    ───
    GENERIC_FOOD queries now pass prefer_generic=True to get_nutrition, which
    adds a dataType filter to the USDA API request, restricting results to
    Foundation, SR Legacy, and Survey (FNDDS).  Branded entries never enter the
    pool, so Foundation items with scores ≥ 65 always win.
    """

    def test_generic_food_router_passes_prefer_generic_true(self):
        """
        The GENERIC_FOOD router path must call get_nutrition with
        prefer_generic=True so that the USDA request excludes branded entries.

        Protects against: silently dropping the flag when the router is refactored.
        """
        captured_calls: list[dict] = []

        original_get_nutrition = __import__(
            "app.services.nutrition_service", fromlist=["get_nutrition"]
        ).get_nutrition

        def spy_get_nutrition(query, *, quantity=0.0, unit=None, size_modifier=None,
                              prefer_generic=False):
            captured_calls.append({"query": query, "prefer_generic": prefer_generic})
            return original_get_nutrition(
                query, quantity=quantity,
                unit=unit,
                size_modifier=size_modifier,
                prefer_generic=prefer_generic,
            )

        with patch("app.services.query_router.get_nutrition", side_effect=spy_get_nutrition), \
             patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            route_food_query("chicken breast")

        assert captured_calls, "get_nutrition was never called"
        call = captured_calls[0]
        assert call["prefer_generic"] is True, (
            f"prefer_generic={call['prefer_generic']!r}; "
            "GENERIC_FOOD router path must pass prefer_generic=True to ensure "
            "branded items are excluded from the USDA pool."
        )

    def test_prefer_generic_sends_datatype_filter_to_usda(self):
        """
        When prefer_generic=True, the USDA HTTP request must include the
        dataType parameter containing Foundation, SR Legacy, and Survey (FNDDS).

        This is the mechanism that prevents branded items from flooding the pool.
        """
        from app.services.nutrition_service import _fetch_nutrition, _GENERIC_DATA_TYPES

        captured_params: list[dict] = []

        def capture_get(url, *, params=None, timeout=None, **kw):
            captured_params.append(dict(params or {}))
            return _usda_response(
                "Broccoli, cooked, boiled, drained", "SR Legacy", 35.0
            )

        # Use broccoli (non-verified) so the USDA HTTP call actually fires.
        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            _fetch_nutrition("broccoli", prefer_generic=True)

        assert captured_params, "httpx.get was never called"
        sent = captured_params[0]
        assert "dataType" in sent, (
            "prefer_generic=True must add 'dataType' to the USDA request params; "
            f"actual params: {sent}"
        )
        sent_types = sent["dataType"]
        for expected in _GENERIC_DATA_TYPES:
            assert expected in sent_types, (
                f"dataType filter missing '{expected}'; sent: {sent_types}"
            )

    def test_prefer_generic_false_sends_no_datatype_filter(self):
        """
        When prefer_generic=False (the default), the USDA request must NOT
        include a dataType filter — preserving current behaviour for fallback
        paths from branded/restaurant routing.
        """
        from app.services.nutrition_service import _fetch_nutrition

        captured_params: list[dict] = []

        def capture_get(url, *, params=None, timeout=None, **kw):
            captured_params.append(dict(params or {}))
            return _usda_response("French fries", "SR Legacy", 365.0)

        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            _fetch_nutrition("french fries", prefer_generic=False)

        assert captured_params
        assert "dataType" not in captured_params[0], (
            "prefer_generic=False must NOT send a dataType filter; "
            f"actual params: {captured_params[0]}"
        )

    def test_prefer_generic_retries_without_datatype_on_400(self):
        """
        USDA occasionally rejects filtered searches with HTTP 400.  The generic
        path should retry once without the dataType filter instead of falling
        straight to a vague estimate.
        """
        from app.services.nutrition_service import _fetch_nutrition

        bad_resp = MagicMock()
        bad_resp.status_code = 400

        good_resp = _usda_response(
            "Broccoli, cooked, boiled, drained",
            "SR Legacy", 35.0, protein=2.4, carbs=7.2, fat=0.4
        )

        captured_params: list[dict] = []

        def capture_get(url, *, params=None, timeout=None, **kw):
            captured_params.append(dict(params or {}))
            return bad_resp if len(captured_params) == 1 else good_resp

        # Use broccoli (non-verified) so both USDA calls actually fire.
        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            result = _fetch_nutrition("broccoli", prefer_generic=True)

        assert len(captured_params) == 2
        assert "dataType" in captured_params[0]
        assert "dataType" not in captured_params[1]
        assert result["is_estimated"] is False
        assert result["calories"] == pytest.approx(35.0)

    def test_branded_only_pool_triggers_fallback_without_filter(self):
        """
        Confirms the pre-fix failure mode: when the USDA pool contains ONLY
        branded items (all scoring ≤ 10 in our scorer), the best score falls
        below CONFIDENCE_THRESHOLD and is_estimated=True is returned.

        This test documents why prefer_generic=True is necessary.
        """
        from app.services.nutrition_service import _fetch_nutrition

        branded_response = MagicMock()
        branded_response.raise_for_status.return_value = None
        branded_response.json.return_value = {
            "foods": [
                {
                    "description": "Chicken Breast, Grilled",
                    "dataType": "Branded",
                    "foodNutrients": [
                        {"nutrientId": 1008, "value": 110},
                        {"nutrientId": 1003, "value": 25},
                        {"nutrientId": 1005, "value": 0},
                        {"nutrientId": 1004, "value": 2},
                    ],
                }
            ] * 10   # ten identical branded items; all score ≤ 10
        }

        with patch("app.services.nutrition_service.httpx.get",
                   return_value=branded_response):
            result = _fetch_nutrition("chicken breast", prefer_generic=False)

        assert result["is_estimated"] is True, (
            "All-branded pool must trigger is_estimated=True "
            "(pre-fix behaviour confirmed)."
        )

    def test_foundation_item_passes_threshold_and_sets_is_estimated_false(self):
        """
        When prefer_generic=True forces a Foundation item into the pool,
        that item scores ≥ 65 and clears CONFIDENCE_THRESHOLD (30), so
        is_estimated must be False — giving the router confidence=0.85.

        This is the post-fix expected behaviour for 'chicken breast'.
        """
        from app.services.nutrition_service import _fetch_nutrition

        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            result = _fetch_nutrition("chicken breast", prefer_generic=True)

        assert result["is_estimated"] is False, (
            "Foundation item scoring ≥ 65 should set is_estimated=False; "
            f"got is_estimated={result['is_estimated']}"
        )
        assert result["calories"] == pytest.approx(165.0)
        assert result["protein"]  == pytest.approx(31.0)

    def test_chicken_breast_router_returns_high_confidence(self):
        """
        End-to-end: route_food_query('chicken breast') must return
        confidence=0.85 when the USDA Foundation item is in the pool.

        This is the direct regression test for the reported confidence=0.45 bug.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            result = route_food_query("chicken breast")

        assert result["confidence"] == pytest.approx(0.85), (
            f"confidence={result['confidence']}; expected 0.85 for a Foundation USDA hit. "
            "If this is 0.45, the prefer_generic=True flag is not reaching _fetch_nutrition."
        )
        assert result["is_estimated"] is False
        assert result["calories"] == pytest.approx(165.0)


# ============================================================
# Phase 9A — Profile coverage and alias resolution
# ============================================================

class TestProfileAliases:
    """
    Verifies that _PROFILE_ALIASES and _VERIFIED_ALIASES resolve plural forms
    and preparation-method variants to the correct base profile / verified entry.

    All tests are offline-only: USDA is patched wherever it would be called.
    """

    # ── Pure unit tests: _profile_for_query alias lookup ────────────────────

    def test_profile_alias_bananas_resolves_to_banana_profile(self):
        """_profile_for_query('bananas') must return the banana profile."""
        banana_profile  = _profile_for_query("banana")
        bananas_profile = _profile_for_query("bananas")
        assert bananas_profile is not None
        assert bananas_profile is banana_profile, (
            "'bananas' did not alias to the 'banana' GenericFoodProfile"
        )

    def test_profile_alias_apples_resolves_to_apple_profile(self):
        apple_profile  = _profile_for_query("apple")
        apples_profile = _profile_for_query("apples")
        assert apples_profile is not None
        assert apples_profile is apple_profile

    def test_profile_alias_oranges_resolves_to_orange_profile(self):
        orange_profile  = _profile_for_query("orange")
        oranges_profile = _profile_for_query("oranges")
        assert oranges_profile is not None
        assert oranges_profile is orange_profile

    def test_profile_alias_chicken_breasts_plural(self):
        singular = _profile_for_query("chicken breast")
        plural   = _profile_for_query("chicken breasts")
        assert plural is not None
        assert plural is singular

    def test_profile_alias_scrambled_eggs_resolves_to_egg_profile(self):
        egg_profile = _profile_for_query("egg")
        assert _profile_for_query("scrambled eggs") is egg_profile
        assert _profile_for_query("scrambled egg")  is egg_profile

    def test_profile_alias_fried_eggs_resolves_to_egg_profile(self):
        egg_profile = _profile_for_query("egg")
        assert _profile_for_query("fried eggs") is egg_profile
        assert _profile_for_query("fried egg")  is egg_profile

    def test_profile_alias_boiled_eggs_resolves_to_egg_profile(self):
        egg_profile = _profile_for_query("egg")
        assert _profile_for_query("boiled eggs") is egg_profile
        assert _profile_for_query("boiled egg")  is egg_profile

    def test_profile_alias_poached_eggs_resolves_to_egg_profile(self):
        egg_profile = _profile_for_query("egg")
        assert _profile_for_query("poached eggs") is egg_profile
        assert _profile_for_query("poached egg")  is egg_profile

    def test_profile_alias_grilled_chicken_breast(self):
        cb_profile = _profile_for_query("chicken breast")
        assert _profile_for_query("grilled chicken breast") is cb_profile
        assert _profile_for_query("grilled chicken")        is cb_profile

    def test_profile_alias_baked_chicken_breast(self):
        cb_profile = _profile_for_query("chicken breast")
        assert _profile_for_query("baked chicken breast") is cb_profile

    # ── Regression: direct keys still resolve without aliases ────────────────

    def test_banana_direct_profile_unaffected(self):
        """Adding aliases must not break direct 'banana' profile lookup."""
        profile = _profile_for_query("banana")
        assert profile is not None
        assert profile.default_grams == 118

    def test_egg_direct_profile_unaffected(self):
        profile = _profile_for_query("egg")
        assert profile is not None
        assert profile.default_grams == 50

    def test_eggs_direct_profile_unaffected(self):
        """'eggs' is a direct key (not an alias) — must still resolve."""
        profile = _profile_for_query("eggs")
        assert profile is not None
        assert profile.default_grams == 50

    # ── Integration: verified fast-path respects plural aliases ─────────────

    def test_bananas_plural_hits_verified_banana_entry_no_usda(self):
        """'bananas' must resolve to the verified banana entry (no USDA call)."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = get_nutrition("bananas", prefer_generic=True)
        mock_http.assert_not_called()
        assert result.get("source_type") == "verified_generic"
        assert result.get("source_name") == "Bananas, overripe, raw"

    def test_bananas_plural_scales_by_banana_default_grams(self):
        """Single 'bananas' (qty=1) must scale by 118 g → ~100.3 kcal."""
        with patch("app.services.nutrition_service.httpx.get"):
            result = get_nutrition("bananas", prefer_generic=True)
        assert abs(result["calories"] - 100.3) < 1.0, (
            f"Expected ~100.3 kcal for 1 banana (118g), got {result['calories']}"
        )

    def test_2_bananas_plural_scales_correctly(self):
        """2 bananas (2 × 118 g = 236 g) must return ~200.6 kcal from verified entry."""
        with patch("app.services.nutrition_service.httpx.get") as mock_http:
            result = get_nutrition("bananas", quantity=2.0, prefer_generic=True)
        mock_http.assert_not_called()
        assert abs(result["calories"] - 200.6) < 2.0, (
            f"Expected ~200.6 kcal for 2 bananas (236g), got {result['calories']}"
        )

    # ── Integration: prep-modifier aliases use profile scaling (not per-100g) ─

    def test_scrambled_eggs_profile_controls_serving_not_per_100g(self):
        """
        'scrambled eggs' with the egg alias must return a gram-based serving
        description rather than raw 'per 100g'.  The egg profile default of
        50 g (1 egg) should be applied.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Egg, whole, cooked, scrambled", "Foundation",
                       calories=148.0, protein=10.0, carbs=1.4, fat=11.0
                   )):
            result = get_nutrition("scrambled eggs", prefer_generic=True)

        assert result.get("serving_description") != "per 100g", (
            "scrambled eggs must not return bare per-100g data; "
            "egg profile should apply default_grams=50"
        )
        assert result.get("is_estimated") is False
        assert abs(result["calories"] - 74.0) < 2.0, (
            f"Expected ~74.0 kcal for 1-egg serving (50g × 148/100), "
            f"got {result['calories']}"
        )

    def test_fried_eggs_profile_controls_serving(self):
        """'fried eggs' alias must apply the egg profile (50 g default)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Egg, whole, cooked, fried", "Foundation",
                       calories=196.0, protein=13.6, carbs=0.8, fat=14.8
                   )):
            result = get_nutrition("fried eggs", prefer_generic=True)

        assert result.get("serving_description") != "per 100g"
        assert result.get("is_estimated") is False
        # 196 kcal/100g × 50g = 98 kcal
        assert abs(result["calories"] - 98.0) < 2.0, (
            f"Expected ~98.0 kcal for 1 fried egg (50g), got {result['calories']}"
        )

    def test_boiled_eggs_profile_controls_serving(self):
        """'boiled eggs' alias must apply the egg profile (50 g default)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Egg, whole, cooked, hard-boiled", "Foundation",
                       calories=155.0, protein=12.6, carbs=1.1, fat=10.6
                   )):
            result = get_nutrition("boiled eggs", prefer_generic=True)

        assert result.get("serving_description") != "per 100g"
        assert result.get("is_estimated") is False
        # 155 kcal/100g × 50g = 77.5 kcal
        assert abs(result["calories"] - 77.5) < 2.0, (
            f"Expected ~77.5 kcal for 1 boiled egg (50g), got {result['calories']}"
        )

    def test_grilled_chicken_breast_profile_controls_serving(self):
        """
        'grilled chicken breast' must use the chicken breast profile
        (100 g default) instead of returning per-100g without a serving context.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
                       "Foundation",
                       calories=165.0, protein=31.0, carbs=0.0, fat=3.6
                   )):
            result = get_nutrition("grilled chicken breast", prefer_generic=True)

        assert result.get("serving_description") != "per 100g", (
            "grilled chicken breast should use profile-based serving, not per 100g"
        )
        assert result.get("is_estimated") is False
        assert abs(result["calories"] - 165.0) < 2.0, (
            f"Expected ~165.0 kcal (100g default), got {result['calories']}"
        )


# ============================================================
# Phase 9B — Composite food guardrails
# ============================================================

class TestCompositeGuardrails:
    """
    Verifies that known whole-food composite phrases are not over-fragmented
    by the composite service and that sandwich profiles steer USDA toward
    correct sources.

    All tests are offline-only; USDA is patched.
    """

    # ── Core anti-fragmentation tests ────────────────────────────────────────

    def test_pbj_sandwich_not_decomposed_into_two_components(self):
        """
        'peanut butter and jelly sandwich' must not be split into
        ['peanut butter', 'jelly sandwich'].  The known-whole-food fast-path
        must fire and return a single-serving result.

        Before Phase 9B this returned ~865 kcal from fragmented components.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, peanut butter and jelly", "Survey (FNDDS)",
                       calories=232.0, protein=9.0, carbs=37.0, fat=7.5
                   )):
            result = route_food_query("peanut butter and jelly sandwich")

        # Decomposition would produce serving="2-component meal";
        # the fast-path produces a gram-based serving from the profile.
        assert result.get("serving_description") != "2-component meal", (
            "PBJ sandwich was still fragmented into components "
            "(serving='2-component meal'); the known-whole-food guard did not fire"
        )
        assert result.get("source_type") == "composite_meal"
        assert result.get("is_estimated") is False
        # Profile applies 167 g default: 232 kcal/100 g × 1.67 ≈ 387 kcal
        assert 330 <= result["calories"] <= 470, (
            f"Expected 330-470 kcal for a PBJ sandwich, got {result['calories']}"
        )

    def test_pbj_sandwich_calories_far_below_865(self):
        """Explicit regression: PBJ must return less than 700 kcal."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, peanut butter and jelly", "Survey (FNDDS)",
                       calories=232.0, protein=9.0, carbs=37.0, fat=7.5
                   )):
            result = route_food_query("peanut butter and jelly sandwich")
        assert result["calories"] < 700, (
            f"PBJ sandwich returned {result['calories']} kcal — over-fragmentation "
            "regression detected (expected < 700 kcal)"
        )

    # ── Profile alias resolution tests ───────────────────────────────────────

    def test_pbj_short_form_resolves_to_pbj_profile(self):
        """'pbj sandwich' alias must resolve to the PBJ sandwich profile."""
        from app.services.nutrition_service import _profile_for_query
        pbj_full  = _profile_for_query("peanut butter and jelly sandwich")
        pbj_short = _profile_for_query("pbj sandwich")
        assert pbj_short is not None
        assert pbj_short is pbj_full, (
            "'pbj sandwich' did not alias to the 'peanut butter and jelly sandwich' profile"
        )

    def test_peanut_butter_jelly_no_and_resolves_to_pbj_profile(self):
        """'peanut butter jelly sandwich' (no 'and') must alias to the PBJ profile."""
        from app.services.nutrition_service import _profile_for_query
        pbj_full  = _profile_for_query("peanut butter and jelly sandwich")
        pbj_nand  = _profile_for_query("peanut butter jelly sandwich")
        assert pbj_nand is not None
        assert pbj_nand is pbj_full

    # ── USDA source steering tests ────────────────────────────────────────────

    def test_peanut_butter_sandwich_does_not_return_cookie_source(self):
        """
        'peanut butter sandwich' must steer USDA away from
        'Cookies, peanut butter sandwich, regular'.

        The profile's avoid_terms=('cookie', 'wafer') must penalise the cookie
        entry so a real sandwich entry wins.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       # Wrong result (cookie) — must be penalised by avoid_terms
                       ("Cookies, peanut butter sandwich, regular", "SR Legacy",
                        478.0, 8.8, 65.6, 20.7),
                       # Correct result — should win
                       ("Sandwich, peanut butter", "Survey (FNDDS)",
                        260.0, 11.0, 30.0, 12.0),
                   )):
            result = route_food_query("peanut butter sandwich")

        assert "cookie" not in (result.get("source_name") or "").lower(), (
            f"peanut butter sandwich matched a cookie source: {result.get('source_name')!r}"
        )
        # Profile applies 140 g default; mocked sandwich is 260 kcal/100g × 1.40 = 364 kcal
        assert result.get("is_estimated") is False
        assert 280 <= result["calories"] <= 440, (
            f"Expected 280-440 kcal for a PB sandwich, got {result['calories']}"
        )

    # ── Reasonable calorie range tests ───────────────────────────────────────

    def test_grilled_cheese_sandwich_reasonable_calories(self):
        """'grilled cheese sandwich' must return a reasonable calorie estimate."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, grilled cheese", "Survey (FNDDS)",
                       calories=305.0, protein=14.0, carbs=25.0, fat=16.0
                   )):
            result = route_food_query("grilled cheese sandwich")

        # 305 kcal/100g × 125g = 381 kcal from profile default
        assert 280 <= result["calories"] <= 520, (
            f"Expected 280-520 kcal for grilled cheese sandwich, got {result['calories']}"
        )
        assert result.get("is_estimated") is False

    def test_turkey_sandwich_reasonable_calories(self):
        """'turkey sandwich' must return a reasonable calorie estimate."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, turkey", "Survey (FNDDS)",
                       calories=202.0, protein=16.0, carbs=23.0, fat=5.8
                   )):
            result = route_food_query("turkey sandwich")

        # 202 kcal/100g × 170g = 343 kcal from profile default
        assert 250 <= result["calories"] <= 480, (
            f"Expected 250-480 kcal for turkey sandwich, got {result['calories']}"
        )
        assert result.get("is_estimated") is False

    def test_turkey_sandwich_on_wheat_reasonable_calories(self):
        """'turkey sandwich on wheat' (composite route) must return a reasonable estimate."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, turkey, on wheat", "Survey (FNDDS)",
                       calories=200.0, protein=17.0, carbs=25.0, fat=5.0
                   )):
            result = route_food_query("turkey sandwich on wheat")

        assert 250 <= result["calories"] <= 480, (
            f"Expected 250-480 kcal for turkey sandwich on wheat, got {result['calories']}"
        )
        assert result.get("is_estimated") is False
        assert result.get("source_type") == "composite_meal"

    def test_turkey_sandwich_on_rye_reasonable_calories(self):
        """'turkey sandwich on rye' (composite route) must return a reasonable estimate."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sandwich, turkey, on rye", "Survey (FNDDS)",
                       calories=200.0, protein=17.0, carbs=25.0, fat=5.0
                   )):
            result = route_food_query("turkey sandwich on rye")

        assert 250 <= result["calories"] <= 480, (
            f"Expected 250-480 kcal for turkey sandwich on rye, got {result['calories']}"
        )
        assert result.get("is_estimated") is False
        assert result.get("source_type") == "composite_meal"


# ============================================================
# Phase 9C — Meal-size profiles
# ============================================================

class TestMealSizeProfiles:
    """
    Verifies that common meal-style queries return full-serving calorie
    estimates rather than per-100g fragments.

    All tests are offline; USDA is patched with realistic Survey (FNDDS)
    per-100g values.  After profile scaling the totals should fall in the
    target ranges from the Phase 9C spec.
    """

    def test_chicken_rice_bowl_full_meal_range(self):
        """'chicken rice bowl' must return a full-bowl serving (target 450–700 kcal)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Bowl, rice, with chicken", "Survey (FNDDS)",
                       calories=140.0, protein=12.0, carbs=20.0, fat=3.0
                   )):
            result = route_food_query("chicken rice bowl")

        # Profile applies 400 g default: 140 × 4.0 = 560 kcal
        assert 450 <= result["calories"] <= 700, (
            f"Expected 450–700 kcal for chicken rice bowl, got {result['calories']}. "
            "Likely returned per-100g instead of full-bowl serving."
        )
        assert result.get("serving_description") != "per 100g"
        assert result.get("is_estimated") is False

    def test_chicken_and_rice_bowl_not_fragmented(self):
        """
        'chicken and rice bowl' (COMPOSITE_MEAL due to 'and') must not be
        split into ['chicken', 'rice bowl'].  The _KNOWN_WHOLE_FOODS guard
        must fire and return a single-bowl result.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Bowl, rice, with chicken", "Survey (FNDDS)",
                       calories=140.0, protein=12.0, carbs=20.0, fat=3.0
                   )):
            result = route_food_query("chicken and rice bowl")

        assert 450 <= result["calories"] <= 700, (
            f"Expected 450–700 kcal for chicken and rice bowl, got {result['calories']}"
        )
        assert result.get("serving_description") != "2-component meal", (
            "'chicken and rice bowl' was fragmented into components"
        )
        assert result.get("source_type") == "composite_meal"

    def test_chicken_bowl_full_meal_range(self):
        """'chicken bowl' must return a full-bowl serving (target 400–700 kcal)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Bowl, chicken", "Survey (FNDDS)",
                       calories=140.0, protein=20.0, carbs=15.0, fat=4.0
                   )):
            result = route_food_query("chicken bowl")

        # Profile: 350 g × 1.40 = 490 kcal
        assert 400 <= result["calories"] <= 700, (
            f"Expected 400–700 kcal for chicken bowl, got {result['calories']}"
        )
        assert result.get("serving_description") != "per 100g"
        assert result.get("is_estimated") is False

    def test_salad_with_chicken_composite_reasonable_range(self):
        """
        'salad with chicken' (COMPOSITE_MEAL) is decomposed into salad + chicken
        components and the totals must land in a reasonable range (150–600 kcal).

        Each component call receives the same mock, so the test verifies the
        aggregation path produces a plausible result rather than pinning an
        exact serving size.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Salad, chicken, grilled", "Survey (FNDDS)",
                       calories=120.0, protein=14.0, carbs=6.0, fat=5.0
                   )):
            result = route_food_query("salad with chicken")

        # Decomposition: salad (~120 kcal) + chicken (~120 kcal) ≈ 240 kcal
        assert 150 <= result["calories"] <= 600, (
            f"Expected 150–600 kcal for salad with chicken composite, got {result['calories']}"
        )
        assert result.get("source_type") == "composite_meal"

    def test_banana_smoothie_full_drink_range(self):
        """
        'banana smoothie' must return a full-drink estimate (target 250–500 kcal).

        No profile is registered for 'banana smoothie' — the _MEAL_CALORIE_FLOOR
        for 'smoothie' (150 kcal/100g) rejects ingredient-level USDA hits and
        falls back to the rule-based 300 kcal smoothie estimate.
        """
        # Mock USDA returning the raw banana ingredient (would trigger floor)
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Bananas, raw", "Foundation",
                       calories=85.0, protein=1.1, carbs=22.8, fat=0.3
                   )):
            result = route_food_query("banana smoothie")

        # Floor rejects 85 kcal < 150 floor → rule-based fallback 300 kcal
        assert 250 <= result["calories"] <= 500, (
            f"Expected 250–500 kcal for banana smoothie, got {result['calories']}"
        )
        # Floor-triggered results use is_estimated=True
        assert result.get("is_estimated") is True

    def test_protein_shake_full_drink_range(self):
        """
        'protein shake' must return a full-bottle serving (target 150–350 kcal).

        Before Phase 9C it returned ~61 kcal (per-100g SlimFast RTD unscaled).
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Protein shake, ready to drink", "Survey (FNDDS)",
                       calories=65.0, protein=15.0, carbs=5.0, fat=2.0
                   )):
            result = route_food_query("protein shake")

        # Profile: 330 g × 0.65 = 214 kcal
        assert 150 <= result["calories"] <= 350, (
            f"Expected 150–350 kcal for protein shake, got {result['calories']}. "
            "Likely returned per-100g instead of full-bottle serving."
        )
        assert result.get("serving_description") != "per 100g"
        assert result.get("is_estimated") is False

    def test_chipotle_chicken_bowl_rule_based_realistic(self):
        """
        'chipotle chicken bowl' (RESTAURANT_ITEM) falls back to rule-based
        when OFF misses.  The fallback must return a realistic bowl estimate
        (target 500–850 kcal) instead of the former generic 250 kcal.

        OFF is patched to return None so the rule-based path is isolated.
        """
        with patch("app.services.query_router.search_restaurant_item", return_value=None):
            result = route_food_query("chipotle chicken bowl")

        assert 500 <= result["calories"] <= 850, (
            f"Expected 500–850 kcal for chipotle chicken bowl (rule-based), "
            f"got {result['calories']}"
        )
        assert result.get("source_type") == "restaurant_guess"
        assert result.get("is_estimated") is True


# ============================================================
# Phase 9D — Unit and portion scaling fixes
# ============================================================

class TestUnitAndPortionScaling:
    """
    Verifies that tbsp/tsp/oz unit queries scale correctly from per-100g USDA
    data, and that 'coffee with milk' returns a realistic splash-sized estimate
    rather than a full cup of milk.

    All tests are offline; USDA is patched with realistic per-100g values.
    """

    # ── Butter ────────────────────────────────────────────────────────────────

    def test_1_tbsp_butter_reasonable_calories(self):
        """1 tbsp butter (14.2 g) must return ~90–115 kcal, not 717 kcal (per-100g)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Butter, salted", "SR Legacy",
                       calories=717.0, protein=0.9, carbs=0.1, fat=81.1
                   )):
            result = route_food_query("1 tbsp butter")

        # 717 × (14.2 / 100) ≈ 101.8 kcal
        assert 85 <= result["calories"] <= 120, (
            f"Expected 85–120 kcal for 1 tbsp butter (14.2 g), got {result['calories']}. "
            "Likely returned per-100g (717 kcal) instead of tbsp-scaled value."
        )
        assert result.get("is_estimated") is False
        assert result.get("serving_description") == "1 tbsp"

    def test_2_tbsp_butter_doubles_1_tbsp(self):
        """2 tbsp butter must return approximately double the 1-tbsp value."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Butter, salted", "SR Legacy",
                       calories=717.0, protein=0.9, carbs=0.1, fat=81.1
                   )):
            result_1 = route_food_query("1 tbsp butter")
            result_2 = route_food_query("2 tbsp butter")

        assert result_2["calories"] == pytest.approx(result_1["calories"] * 2, rel=0.02), (
            f"2 tbsp butter ({result_2['calories']}) should be ~2× 1 tbsp ({result_1['calories']})"
        )
        assert 170 <= result_2["calories"] <= 240, (
            f"Expected 170–240 kcal for 2 tbsp butter, got {result_2['calories']}"
        )

    # ── Sugar ─────────────────────────────────────────────────────────────────

    def test_1_tsp_sugar_reasonable_calories(self):
        """1 tsp sugar (4 g) must return ~12–20 kcal, not 387 kcal (per-100g)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sugars, granulated", "SR Legacy",
                       calories=387.0, protein=0.0, carbs=100.0, fat=0.0
                   )):
            result = route_food_query("1 tsp sugar")

        # 387 × (4 / 100) ≈ 15.5 kcal
        assert 12 <= result["calories"] <= 20, (
            f"Expected 12–20 kcal for 1 tsp sugar (4 g), got {result['calories']}. "
            "Likely returned per-100g (387 kcal) instead of tsp-scaled value."
        )
        assert result.get("is_estimated") is False
        assert result.get("serving_description") == "1 tsp"

    def test_1_tbsp_sugar_reasonable_calories(self):
        """1 tbsp sugar (12 g) must return ~40–60 kcal."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Sugars, granulated", "SR Legacy",
                       calories=387.0, protein=0.0, carbs=100.0, fat=0.0
                   )):
            result = route_food_query("1 tbsp sugar")

        # 387 × (12 / 100) ≈ 46.4 kcal
        assert 40 <= result["calories"] <= 60, (
            f"Expected 40–60 kcal for 1 tbsp sugar (12 g), got {result['calories']}"
        )
        assert result.get("is_estimated") is False

    # ── Steak ─────────────────────────────────────────────────────────────────

    def test_4_oz_steak_reasonable_calories(self):
        """4 oz steak (113.4 g) must return ~250–350 kcal, not 0 kcal."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Beef, steak, cooked, broiled", "SR Legacy",
                       calories=271.0, protein=26.0, carbs=0.0, fat=18.0
                   )):
            result = route_food_query("4 oz steak")

        # 271 × (4 × 28.3495 / 100) ≈ 271 × 1.134 ≈ 307 kcal
        assert 250 <= result["calories"] <= 370, (
            f"Expected 250–370 kcal for 4 oz steak, got {result['calories']}. "
            "Likely oz was treated as item count (× 4 per-100g) or returned 0."
        )
        assert result.get("is_estimated") is False

    def test_100g_steak_reasonable_calories(self):
        """100g steak must return the USDA per-100g value directly."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Beef, steak, cooked, broiled", "SR Legacy",
                       calories=271.0, protein=26.0, carbs=0.0, fat=18.0
                   )):
            result = route_food_query("100g steak")

        assert result["calories"] == pytest.approx(271.0, rel=0.02), (
            f"100g steak should return USDA per-100g value ≈ 271 kcal, got {result['calories']}"
        )
        assert result.get("is_estimated") is False

    def test_steak_profile_exists_and_has_correct_defaults(self):
        """Steak profile must exist with default_grams=170 for a typical 6-oz serving."""
        profile = _profile_for_query("steak")
        assert profile is not None, "No profile for 'steak'"
        assert profile.default_grams == pytest.approx(170.0)

    def test_steak_profile_penalizes_relish(self):
        """
        'steak' query must not select 'Pickle relish, hot dog' over a real steak entry.
        The steak profile's avoid_terms must penalise relish and hot dog.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Pickle relish, hot dog", "SR Legacy", 90.0, 0.5, 22.0, 0.2),
                       ("Beef, steak, cooked, broiled", "SR Legacy", 271.0, 26.0, 0.0, 18.0),
                   )):
            result = route_food_query("steak")

        assert "relish" not in (result.get("source_name") or "").lower(), (
            f"Steak query matched relish source: {result.get('source_name')!r}"
        )

    # ── Coffee with milk ──────────────────────────────────────────────────────

    def test_coffee_with_milk_not_over_estimated(self):
        """
        'coffee with milk' must return under 130 kcal.

        Before Phase 9D the composite service added a full cup of milk
        (244 g → ~150 kcal fallback) producing ~250 kcal — far above the
        realistic ~25–60 kcal for black coffee + a splash of milk.

        The fix uses two layers:
          1. _KNOWN_WHOLE_FOODS prevents decomposition into [coffee, full-cup-milk].
          2. _MEAL_CALORIE_FLOOR ("coffee with" ≥ 15 kcal) rejects plain-coffee
             USDA results (~1–2 kcal/100g) and falls back to 50 kcal.
        """
        # Simulate USDA returning plain brewed coffee (would give ~2 kcal total)
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Beverages, coffee, brewed, prepared with tap water",
                       "Foundation", calories=1.0
                   )):
            result = route_food_query("coffee with milk")

        assert result["calories"] < 130, (
            f"coffee with milk returned {result['calories']} kcal — "
            "over-estimation regression (full cup of milk composited)"
        )
        # Must still have non-zero calories (not black-coffee 0 kcal) —
        # the meal-calorie floor should have rejected the 1-kcal USDA result
        # and used the 50 kcal fallback.
        assert result["calories"] > 5, (
            f"coffee with milk returned {result['calories']} kcal — "
            "floor rejected the low USDA result but fallback was not applied"
        )

    def test_coffee_with_milk_reasonable_range(self):
        """'coffee with milk' realistic range: 20–100 kcal (fallback path)."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response(
                       "Beverages, coffee, brewed, prepared with tap water",
                       "Foundation", calories=1.0
                   )):
            result = route_food_query("coffee with milk")

        assert 20 <= result["calories"] <= 100, (
            f"Expected 20–100 kcal for coffee with milk, got {result['calories']}"
        )

    def test_coffee_with_1_cup_milk_explicit_quantity_decomposes(self):
        """
        'coffee with 1 cup milk' has an explicit cup quantity and must NOT
        hit the 'coffee with milk' whole-food shortcut — the full query string
        does not match the shortcut key.  It should decompose into 2 components.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Coffee, brewed", "Foundation", 2.0)):
            result = route_food_query("coffee with 1 cup milk")

        # Must decompose into 2 components (coffee + 1 cup milk)
        assert result.get("serving_description") == "2-component meal", (
            f"'coffee with 1 cup milk' should decompose into 2 components; "
            f"got serving={result.get('serving_description')!r}. "
            "The whole-food shortcut ('coffee with milk') must not match this query."
        )
        assert result.get("source_type") == "composite_meal"


# ============================================================
# Phase 9E — Source selection cleanup
# ============================================================

class TestSourceSelectionCleanup:
    """
    Targeted fixes for two queries that were selecting the wrong USDA source
    or routing to the wrong service.

    All tests are offline; USDA is patched where relevant.
    """

    # ── costco hot dog ────────────────────────────────────────────────────────

    def test_costco_routes_as_restaurant_not_generic(self):
        """
        'costco hot dog' must be classified as RESTAURANT_ITEM now that
        'costco' is in _RESTAURANT_SIGNALS.  Before Phase 9E it routed as
        GENERIC_FOOD → USDA → 'Pickle relish, hot dog' (91 kcal).
        """
        from app.services.query_classifier import classify, QueryClass
        from app.services.query_parser import parse
        parsed = parse("costco hot dog")
        cls = classify(parsed)
        assert cls == QueryClass.RESTAURANT_ITEM, (
            f"'costco hot dog' classified as {cls.value}; expected RESTAURANT_ITEM. "
            "'costco' must be in _RESTAURANT_SIGNALS."
        )

    def test_costco_hot_dog_realistic_calories(self):
        """
        'costco hot dog' (RESTAURANT_ITEM) must return a realistic hot-dog
        estimate (target 280–550 kcal), not 91 kcal from USDA 'Pickle relish'.

        Result may come from OFF (is_estimated=False) or the rule-based fallback
        (is_estimated=True) depending on what OFF returns at call time.
        """
        result = route_food_query("costco hot dog")

        assert 280 <= result["calories"] <= 550, (
            f"Expected 280–550 kcal for costco hot dog, got {result['calories']}. "
            "Previously returned 91 kcal (USDA 'Pickle relish, hot dog')."
        )
        # Source must be restaurant (either a live OFF hit or rule-based fallback)
        assert result.get("source_type") in ("restaurant", "restaurant_guess"), (
            f"source_type={result.get('source_type')!r}; expected restaurant path"
        )


# ============================================================
# Phase 10C — OFF serving-size scaling
# ============================================================

class TestOFFServingScaling:
    """
    Unit tests for the three-level serving-size cascade added in Phase 10C.

    OFF v3 search results rarely include serving_size.  The cascade falls
    back to (1) fl-oz quantity field for beverages, (2) _OFF_SERVING_GRAMS
    keyword lookup for known foods.  All tests are offline — they call
    _normalize_product directly with mock product dicts.
    """

    # ── Helper lookup tables ──────────────────────────────────────────────────

    def test_packaged_serving_grams_hershey_bar(self):
        from app.services.packaged_product_service import _serving_grams_for_name
        assert _serving_grams_for_name("Hershey Bar") == pytest.approx(43.0)

    def test_packaged_serving_grams_oreo_cookies(self):
        from app.services.packaged_product_service import _serving_grams_for_name
        assert _serving_grams_for_name("Oreo Cookies") == pytest.approx(34.0)

    def test_packaged_serving_grams_unknown_returns_none(self):
        from app.services.packaged_product_service import _serving_grams_for_name
        assert _serving_grams_for_name("Random Product XYZ") is None

    def test_restaurant_serving_grams_chipotle_bowl(self):
        from app.services.restaurant_service import _serving_grams_for_name
        assert _serving_grams_for_name("Chipotle Chicken Bowl") == pytest.approx(450.0)

    def test_fl_oz_only_parses_frappuccino_bottle(self):
        from app.services.packaged_product_service import _parse_fl_oz_only
        grams = _parse_fl_oz_only("13.7 fl oz")
        assert grams == pytest.approx(13.7 * 29.5735, rel=0.01)

    def test_fl_oz_only_rejects_grams_string(self):
        """Package weights in grams must not be used as serving proxy."""
        from app.services.packaged_product_service import _parse_fl_oz_only
        assert _parse_fl_oz_only("263 g") is None

    def test_fl_oz_only_rejects_solid_oz(self):
        """Plain 'oz' (solid food) must not be treated as fl oz."""
        from app.services.packaged_product_service import _parse_fl_oz_only
        assert _parse_fl_oz_only("9 oz") is None

    # ── _normalize_product integration ───────────────────────────────────────

    def _make_product(self, name, brands, cal100, protein=5.0, carbs=20.0,
                      fat=5.0, quantity=None):
        """Build a minimal OFF v3 product dict."""
        return {
            "product_name": name,
            "brands": brands,
            "nutriments": {
                "energy-kcal_100g": cal100,
                "proteins_100g":    protein,
                "carbohydrates_100g": carbs,
                "fat_100g":         fat,
            },
            **({"quantity": quantity} if quantity else {}),
        }

    def test_hershey_bar_scales_to_43g_serving(self):
        """Hershey Bar (488 kcal/100g) must scale to a 43g serving (~210 kcal)."""
        from app.services.packaged_product_service import _normalize_product
        product = self._make_product("Hershey Bar", ["Hershey's"], 488.0)
        result = _normalize_product(product)
        assert result is not None
        # 488 × (43/100) ≈ 209.8 kcal
        assert 190 <= result["calories"] <= 230, (
            f"Expected 190–230 kcal for Hershey Bar (43g serving), got {result['calories']}"
        )

    def test_oreo_cookies_scales_to_34g_serving(self):
        """Oreo Cookies (467 kcal/100g) must scale to a 34g serving (~159 kcal)."""
        from app.services.packaged_product_service import _normalize_product
        product = self._make_product("Oreo Cookies", ["Oreo"], 467.0)
        result = _normalize_product(product)
        assert result is not None
        # 467 × (34/100) ≈ 158.8 kcal
        assert 140 <= result["calories"] <= 185, (
            f"Expected 140–185 kcal for Oreo Cookies (34g serving), got {result['calories']}"
        )

    def test_starbucks_frappuccino_scales_from_fl_oz_quantity(self):
        """
        Starbucks Caramel Frappuccino (74 kcal/100g, qty='13.7 fl oz') must
        scale via the fl-oz quantity fallback to ~300 kcal.
        """
        from app.services.restaurant_service import _normalize_product
        product = self._make_product(
            "Caramel Frappuccino", ["Starbucks"], 74.0, quantity="13.7 fl oz"
        )
        result = _normalize_product(product)
        assert result is not None
        # 74 × (13.7 × 29.5735 / 100) ≈ 300 kcal
        assert 258 <= result["calories"] <= 370, (
            f"Expected 258–370 kcal for Caramel Frappuccino (13.7 fl oz), got {result['calories']}"
        )

    def test_chipotle_chicken_bowl_scales_to_450g_serving(self):
        """
        Chipotle Chicken Bowl (147 kcal/100g) must scale to a 450g serving
        (~661 kcal) via the _OFF_SERVING_GRAMS keyword fallback.
        """
        from app.services.restaurant_service import _normalize_product
        product = self._make_product("Chipotle Chicken Bowl", [], 147.0)
        result = _normalize_product(product)
        assert result is not None
        # 147 × (450/100) = 661.5 kcal
        assert 480 <= result["calories"] <= 780, (
            f"Expected 480–780 kcal for Chipotle Chicken Bowl (450g serving), got {result['calories']}"
        )

    def test_unknown_product_returns_per_100g_unscaled(self):
        """A product with no known serving and no fl-oz qty must return per-100g."""
        from app.services.packaged_product_service import _normalize_product
        product = self._make_product("Some Random Snack Bar", [], 400.0)
        result = _normalize_product(product)
        assert result is not None
        assert result["calories"] == 400, (
            "Unknown product should return per-100g value (no serving-size applied)"
        )

    def test_hot_dog_fallback_reasonable(self):
        """'hot dog' rule-based fallback must return a realistic ballpark estimate."""
        from app.services.nutrition_service import _get_fallback_nutrition
        result = _get_fallback_nutrition("hot dog")
        assert 280 <= result["calories"] <= 500, (
            f"hot dog fallback returned {result['calories']} kcal; expected 280–500"
        )

    # ── turkey sandwich on rye ────────────────────────────────────────────────

    def test_turkey_sandwich_on_rye_avoids_cracker_source(self):
        """
        'turkey sandwich on rye' must not select 'Crackers, rye, sandwich-type
        with cheese filling' (817 kcal).  The profile's avoid_terms must
        penalise 'crackers' so a real sandwich entry wins.
        """
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       # Wrong — must be penalised by 'crackers' avoid_term
                       ("Crackers, rye, sandwich-type with cheese filling",
                        "SR Legacy", 480.0, 9.0, 56.0, 22.0),
                       # Correct
                       ("Sandwich, turkey, on rye bread", "Survey (FNDDS)",
                        198.0, 18.0, 24.0, 4.5),
                   )):
            result = route_food_query("turkey sandwich on rye")

        assert "cracker" not in (result.get("source_name") or "").lower(), (
            f"turkey sandwich on rye matched a cracker source: {result.get('source_name')!r}"
        )
        assert 250 <= result["calories"] <= 520, (
            f"Expected 250–520 kcal for turkey sandwich on rye, got {result['calories']}"
        )
        assert result.get("is_estimated") is False
