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
from app.services.nutrition_service import _fetch_nutrition, get_nutrition
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
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_response("Egg, whole", "Foundation", 70.0,
                                               protein=6.0, carbs=0.6, fat=5.0)):
            single = get_nutrition("egg", prefer_generic=True)
            double = get_nutrition("egg", quantity=2.0, prefer_generic=True)

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

    def test_eggs_profile_penalizes_fried_egg(self):
        """Plain eggs should prefer plain/raw/boiled generic egg data over fried egg."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Egg, whole, cooked, fried", "Survey (FNDDS)", 196.0, 13.6, 0.8, 14.8),
                       ("Egg, whole, raw, fresh", "SR Legacy", 143.0, 12.6, 0.7, 9.5),
                   )):
            result = route_food_query("2 eggs")

        assert result["source_name"] == "Egg, whole, raw, fresh"
        assert result["calories"] == pytest.approx(143.0)

    def test_zero_nutrient_oil_candidate_is_rejected(self):
        """A zero-filled branded oil candidate should not beat usable olive oil data."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("OLIVE OIL", "Branded", 0.0, 0.0, 0.0, 0.0),
                       ("Olive oil", "Survey (FNDDS)", 900.0, 0.0, 0.0, 100.0),
                   )):
            result = route_food_query("1 tbsp olive oil")

        assert result["source_name"] == "Olive oil"
        assert result["calories"] == pytest.approx(121.5, rel=0.01)

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

    def test_white_rice_profile_penalizes_glutinous_rice(self):
        """Plain white rice should prefer regular white rice over glutinous rice."""
        with patch("app.services.nutrition_service.httpx.get",
                   return_value=_usda_multi_response(
                       ("Rice, white, glutinous, unenriched, cooked", "SR Legacy", 97.0, 2.0, 21.1, 0.2),
                       ("Rice, white, long-grain, regular, cooked, enriched, with salt", "SR Legacy", 130.0, 2.7, 28.2, 0.3),
                   )):
            result = route_food_query("white rice")

        assert result["source_name"] == "Rice, white, long-grain, regular, cooked, enriched, with salt", (
            f"source_name={result['source_name']!r}; glutinous rice should be penalised "
            "by the 'glutinous' avoid_term so plain long-grain white rice wins."
        )

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
        assert result["source_type"] in ("generic", "usda", ""), (
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
                "Chicken, broilers or fryers, breast", "Foundation", 165.0
            )

        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            _fetch_nutrition("chicken breast", prefer_generic=True)

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
            "Chicken, broilers or fryers, breast, meat only, cooked, roasted",
            "Foundation", 165.0, protein=31.0, carbs=0.0, fat=3.6
        )

        captured_params: list[dict] = []

        def capture_get(url, *, params=None, timeout=None, **kw):
            captured_params.append(dict(params or {}))
            return bad_resp if len(captured_params) == 1 else good_resp

        with patch("app.services.nutrition_service.httpx.get", side_effect=capture_get):
            result = _fetch_nutrition("chicken breast", prefer_generic=True)

        assert len(captured_params) == 2
        assert "dataType" in captured_params[0]
        assert "dataType" not in captured_params[1]
        assert result["is_estimated"] is False
        assert result["calories"] == pytest.approx(165.0)

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
