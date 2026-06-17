import os
from dataclasses import dataclass, field
from functools import lru_cache
import httpx
from app.services.debug_logger import log_usda_candidates, log_rejection
from app.services.verified_foods import verified_entry_for_query as _verified_entry_for_query

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
        avoid_terms=("raw", "soup", "casserole", "babyfood", "chinese", "raab"),
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
        avoid_terms=("tots", "fries", "chips", "flour", "raw", "frozen"),
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
        avoid_terms=("flour", "dry", "uncooked", "bran", "parboiled"),
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
        search_query="oatmeal cooked plain",
        default_grams=234,
        prefer_terms=("oatmeal", "cooked"),
        avoid_terms=("cookie", "bar", "dry", "instant flavored", "multigrain"),
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
        avoid_terms=("raw", "patty", "patties", "meatballs", "frozen"),
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
        avoid_terms=("dry", "uncooked", "sauce", "gluten-free", "homemade"),
        unit_grams={"cup": 140, "cups": 140},
    ),
    # ── Condiments / fats / sweeteners ───────────────────────────────────────
    # unit_grams allows tbsp/tsp queries to scale correctly from per-100g USDA
    # data instead of returning implausible per-100g unscaled values.
    "butter": GenericFoodProfile(
        search_query="butter",
        default_grams=14,   # 1 tbsp default serving
        prefer_terms=("butter",),
        avoid_terms=("peanut", "almond", "cocoa", "apple", "nut"),
        unit_grams={
            "tbsp": 14.2, "tablespoon": 14.2, "tablespoons": 14.2,
            "tsp": 4.7,   "teaspoon": 4.7,    "teaspoons": 4.7,
        },
    ),
    # ── Condiments & spreads (tbsp-scale) ────────────────────────────────────
    "honey": GenericFoodProfile(
        search_query="honey",
        default_grams=21,   # 1 tbsp default serving
        prefer_terms=("honey",),
        avoid_terms=("cake", "mustard", "glazed", "barbecue", "butter"),
        unit_grams={
            "tbsp": 21.0, "tablespoon": 21.0, "tablespoons": 21.0,
            "tsp": 7.0,   "teaspoon": 7.0,    "teaspoons": 7.0,
        },
    ),
    "hummus": GenericFoodProfile(
        search_query="hummus",
        default_grams=60,   # ~4 tbsp / typical dip serving
        prefer_terms=("hummus",),
        avoid_terms=("chip", "pita", "wrap"),
        unit_grams={
            "tbsp": 15.0, "tablespoon": 15.0, "tablespoons": 15.0,
            "cup": 246.0, "cups": 246.0,
        },
    ),
    "cream cheese": GenericFoodProfile(
        search_query="cream cheese",
        default_grams=29,   # ~2 tbsp default serving
        prefer_terms=("cream", "cheese"),
        avoid_terms=("cake", "frosting", "icing", "pie", "fat-free"),
        unit_grams={
            "tbsp": 14.5, "tablespoon": 14.5, "tablespoons": 14.5,
            "oz": 28.35,
        },
    ),
    "sour cream": GenericFoodProfile(
        search_query="sour cream",
        default_grams=30,   # 2 tbsp default serving
        prefer_terms=("sour", "cream"),
        avoid_terms=("reduced fat", "fat free", "nonfat"),
        unit_grams={
            "tbsp": 15.0, "tablespoon": 15.0, "tablespoons": 15.0,
            "cup": 230.0, "cups": 230.0,
        },
    ),
    "heavy cream": GenericFoodProfile(
        search_query="cream heavy whipping",
        default_grams=15,   # 1 tbsp default serving
        prefer_terms=("cream", "heavy", "whipping"),
        avoid_terms=("half", "light", "sour", "cheese", "ice cream"),
        unit_grams={
            "tbsp": 15.0, "tablespoon": 15.0, "tablespoons": 15.0,
            "tsp": 5.0,   "teaspoon": 5.0,    "teaspoons": 5.0,
            "cup": 238.0, "cups": 238.0,
        },
    ),
    "sugar": GenericFoodProfile(
        search_query="sugar granulated",
        default_grams=4,    # 1 tsp default serving
        prefer_terms=("sugar", "granulated"),
        avoid_terms=("brown", "powdered", "confectioners", "turbinado", "maple"),
        unit_grams={
            "tsp": 4.0,   "teaspoon": 4.0,    "teaspoons": 4.0,
            "tbsp": 12.0, "tablespoon": 12.0, "tablespoons": 12.0,
        },
    ),
    # ── Proteins — weight-based entries ──────────────────────────────────────
    # oz is already handled universally in _grams_from_unit (28.3495 g/oz).
    # A profile is needed so that the profile-scaling path is activated and
    # the USDA search is steered toward a cooked steak entry, not relish.
    "steak": GenericFoodProfile(
        search_query="beef steak cooked",
        default_grams=170,  # typical 6 oz steak
        prefer_terms=("beef", "steak", "cooked"),
        avoid_terms=("raw", "sauce", "relish", "seasoning", "frozen", "hot dog"),
    ),
    # ── Sandwiches ────────────────────────────────────────────────────────────
    # default_grams are typical whole-sandwich weights from USDA FNDDS references.
    # avoid_terms prevent the scorer from selecting snack/cookie items that share
    # a keyword with the sandwich (e.g. "Cookies, peanut butter sandwich").
    "peanut butter and jelly sandwich": GenericFoodProfile(
        search_query="sandwich peanut butter jelly",
        default_grams=167,
        prefer_terms=("sandwich", "peanut", "butter", "jelly"),
        avoid_terms=("cookie", "wafer", "crackers"),
    ),
    "peanut butter sandwich": GenericFoodProfile(
        search_query="sandwich peanut butter",
        default_grams=140,
        prefer_terms=("sandwich", "peanut", "butter"),
        avoid_terms=("cookie", "wafer", "crackers", "jelly", "jam"),
    ),
    "grilled cheese sandwich": GenericFoodProfile(
        search_query="sandwich grilled cheese",
        default_grams=125,
        prefer_terms=("sandwich", "grilled", "cheese"),
        avoid_terms=("soup", "salad", "pasta"),
    ),
    "turkey sandwich": GenericFoodProfile(
        search_query="sandwich turkey",
        default_grams=170,
        prefer_terms=("sandwich", "turkey"),
        avoid_terms=("soup", "salad", "wrap"),
    ),
    "turkey sandwich on wheat": GenericFoodProfile(
        search_query="sandwich turkey wheat",
        default_grams=170,
        prefer_terms=("sandwich", "turkey", "wheat"),
        avoid_terms=("soup", "salad"),
    ),
    "turkey sandwich on rye": GenericFoodProfile(
        search_query="sandwich turkey rye",
        default_grams=170,
        prefer_terms=("sandwich", "turkey", "rye"),
        avoid_terms=("soup", "salad", "crackers", "cracker"),
    ),
    # ── Meals / bowls ─────────────────────────────────────────────────────────
    # default_grams represents a typical whole-meal serving.
    # avoid_terms block frozen entrees and per-100g-only USDA sources that
    # underreport calories when unscaled.
    "chicken rice bowl": GenericFoodProfile(
        search_query="bowl chicken rice cooked",
        default_grams=400,
        prefer_terms=("bowl", "chicken", "rice"),
        avoid_terms=("frozen", "entree", "meal kit", "baby", "babyfood"),
    ),
    "chicken bowl": GenericFoodProfile(
        search_query="bowl chicken cooked",
        default_grams=350,
        prefer_terms=("bowl", "chicken"),
        avoid_terms=("frozen", "entree", "baby"),
    ),
    # "salad with chicken" — leafy salad with cooked chicken breast.
    # This is the key for composite queries that have "with" but should not
    # be decomposed (added to _KNOWN_WHOLE_FOODS in composite_service.py).
    "salad with chicken": GenericFoodProfile(
        search_query="salad chicken breast",
        default_grams=300,
        prefer_terms=("salad", "chicken"),
        avoid_terms=("pasta", "noodle", "soup", "baby", "caeser"),
    ),
    # "chicken salad" — ambiguous: can be a leafy salad with chicken or
    # a mayo-based chicken salad spread. USDA FNDDS "Salad, chicken" typically
    # describes a mayo-based serving. default_grams covers a typical plate/wrap
    # portion for either interpretation.
    "chicken salad": GenericFoodProfile(
        search_query="chicken salad",
        default_grams=200,
        prefer_terms=("chicken", "salad"),
        avoid_terms=("noodle", "soup", "pasta", "baby"),
    ),
    # ── Smoothies / shakes ────────────────────────────────────────────────────
    # NOTE: "banana smoothie" intentionally has NO profile.  The existing
    # _MEAL_CALORIE_FLOOR for "smoothie" (150 kcal) rejects low-calorie USDA
    # ingredient hits (e.g. plain banana at 85 kcal/100g) and falls back to
    # the rule-based 300 kcal smoothie estimate, which is correct behaviour.
    # Adding a profile bypasses that floor check and risks returning an
    # under-scaled result when USDA picks the wrong entry.
    #
    # "protein shake" — ready-to-drink bottles are ~325–415g; per-100g RTD
    # entries in USDA (50–80 kcal/100g) scale correctly with default_grams=330.
    # avoid_terms blocks dry protein powder entries (~380 kcal/100g) that would
    # produce grossly inflated totals when scaled to a full-serving weight.
    "protein shake": GenericFoodProfile(
        search_query="protein shake beverage",
        default_grams=330,
        prefer_terms=("protein", "shake", "beverage"),
        avoid_terms=("powder", "dry", "mix", "unflavored whey", "isolate"),
    ),
    # ── Additional fruits ─────────────────────────────────────────────────────
    "grapes": GenericFoodProfile(
        search_query="grapes raw",
        default_grams=92,
        prefer_terms=("grapes", "raw"),
        avoid_terms=("juice", "raisins", "wine", "dried", "jelly"),
        unit_grams={"cup": 92, "cups": 92},
    ),
    "mango": GenericFoodProfile(
        search_query="mango raw",
        default_grams=165,
        prefer_terms=("mango", "raw"),
        avoid_terms=("juice", "dried", "frozen", "chutney", "nectar"),
        unit_grams={"cup": 165, "cups": 165},
    ),
    "watermelon": GenericFoodProfile(
        search_query="watermelon raw",
        default_grams=280,
        prefer_terms=("watermelon", "raw"),
        avoid_terms=("juice", "rind", "pickled"),
        unit_grams={"cup": 154, "cups": 154},
    ),
    "pineapple": GenericFoodProfile(
        search_query="pineapple raw",
        default_grams=165,
        prefer_terms=("pineapple", "raw"),
        avoid_terms=("juice", "canned", "dried", "upside"),
        unit_grams={"cup": 165, "cups": 165},
    ),
    # ── Additional vegetables ─────────────────────────────────────────────────
    "carrots": GenericFoodProfile(
        search_query="carrots raw",
        default_grams=61,
        prefer_terms=("carrots", "raw"),
        avoid_terms=("juice", "cooked", "frozen", "babyfood", "glazed"),
        unit_grams={"cup": 128, "cups": 128},
    ),
    "cucumber": GenericFoodProfile(
        search_query="cucumber raw",
        default_grams=119,
        prefer_terms=("cucumber", "raw"),
        avoid_terms=("pickled", "pickle", "dill"),
    ),
    "tomato": GenericFoodProfile(
        search_query="tomato raw",
        default_grams=123,
        prefer_terms=("tomato", "raw"),
        avoid_terms=("sauce", "paste", "juice", "canned", "soup", "sun-dried"),
    ),
    # ── Additional proteins ───────────────────────────────────────────────────
    "tuna": GenericFoodProfile(
        search_query="tuna canned water",
        default_grams=85,
        prefer_terms=("tuna", "canned", "water"),
        avoid_terms=("oil", "fresh", "raw", "bluefin", "albacore"),
        unit_grams={"can": 85, "oz": 28.35},
    ),
    "turkey breast": GenericFoodProfile(
        search_query="turkey breast cooked roasted",
        default_grams=85,
        prefer_terms=("turkey", "breast", "cooked"),
        avoid_terms=("raw", "deli", "ground", "lunchmeat", "frozen"),
    ),
    "shrimp": GenericFoodProfile(
        search_query="shrimp cooked moist heat",
        default_grams=85,
        prefer_terms=("shrimp", "cooked"),
        avoid_terms=("raw", "breaded", "fried", "imitation", "frozen"),
        unit_grams={"oz": 28.35},
    ),
    "bacon": GenericFoodProfile(
        search_query="bacon cooked pan-fried",
        default_grams=28,
        prefer_terms=("bacon", "cooked", "pork"),
        avoid_terms=("raw", "turkey", "canadian", "imitation", "bits"),
        unit_grams={"slice": 10, "slices": 10, "strip": 10, "strips": 10},
    ),
    # ── Additional dairy ──────────────────────────────────────────────────────
    "cottage cheese": GenericFoodProfile(
        search_query="cottage cheese",
        default_grams=113,
        prefer_terms=("cottage", "cheese"),
        avoid_terms=("cream cheese", "ricotta", "dry curd"),
        unit_grams={"cup": 226, "cups": 226},
    ),
    # ── Additional grains ─────────────────────────────────────────────────────
    "quinoa": GenericFoodProfile(
        search_query="quinoa cooked",
        default_grams=185,
        prefer_terms=("quinoa", "cooked"),
        avoid_terms=("dry", "uncooked", "flour", "raw"),
        unit_grams={"cup": 185, "cups": 185},
    ),
    "white bread": GenericFoodProfile(
        search_query="bread white commercially prepared",
        default_grams=28,
        prefer_terms=("bread", "white"),
        avoid_terms=("toasted", "reduced calorie", "rye", "wheat", "pumpernickel", "sourdough"),
        unit_grams={"slice": 28, "slices": 28},
    ),
    "whole wheat bread": GenericFoodProfile(
        search_query="bread whole wheat commercially prepared",
        default_grams=28,
        prefer_terms=("bread", "whole", "wheat"),
        avoid_terms=("toasted", "reduced calorie", "white", "rye"),
        unit_grams={"slice": 28, "slices": 28},
    ),
    # ── Additional nuts ───────────────────────────────────────────────────────
    "walnuts": GenericFoodProfile(
        search_query="walnuts english",
        default_grams=28,
        prefer_terms=("walnuts", "english"),
        avoid_terms=("oil", "butter", "flour", "black walnut"),
        unit_grams={"oz": 28.35, "cup": 117, "cups": 117},
    ),
    "cashews": GenericFoodProfile(
        search_query="cashews raw",
        default_grams=28,
        prefer_terms=("cashews", "raw"),
        avoid_terms=("butter", "oil", "flour", "roasted"),
        unit_grams={"oz": 28.35, "cup": 137, "cups": 137},
    ),
    # ── Beverages ─────────────────────────────────────────────────────────────
    "orange juice": GenericFoodProfile(
        search_query="orange juice raw",
        default_grams=248,
        prefer_terms=("orange", "juice", "raw"),
        avoid_terms=("drink", "blend", "concentrate", "fortified"),
        unit_grams={"cup": 248, "cups": 248},
    ),
}


# ---------------------------------------------------------------------------
# Profile alias table
# ---------------------------------------------------------------------------

# Maps normalized query strings to canonical _GENERIC_FOOD_PROFILES keys.
# Keys must already be in _normalize_query() form (lowercase, size-stripped).
# Only add aliases here — never duplicate a full profile entry.
#
# Two categories:
#   1. Plural forms  — same food, just plural ("bananas" → "banana").
#   2. Prep-method variants — cooking style does not change the base
#      profile used for USDA scoring and gram-scaling.  Added-fat differences
#      (butter in scrambled eggs, oil for grilled chicken) are not estimated
#      yet; the base whole-food values are used as an approximation.
_PROFILE_ALIASES: dict[str, str] = {
    # ── Plural / spelling variants ────────────────────────────────────────────
    "bananas":          "banana",
    "apples":           "apple",
    "oranges":          "orange",
    "strawberry":       "strawberries",
    "blueberry":        "blueberries",
    "avocados":         "avocado",
    "grape":            "grapes",
    "mangoes":          "mango",
    "pineapples":       "pineapple",
    "carrot":           "carrots",
    "tomatoes":         "tomato",
    "cucumbers":        "cucumber",
    "chicken breasts":  "chicken breast",
    "tuna fish":        "tuna",
    "canned tuna":      "tuna",
    "walnut":           "walnuts",
    "cashew":           "cashews",
    "almond":           "almonds",
    "black bean":       "black beans",
    "wheat bread":      "whole wheat bread",
    "whole grain bread": "whole wheat bread",
    "toast":            "white bread",
    "toasted bread":    "white bread",
    "greek yoghurt":    "greek yogurt",
    "yogurt":           "greek yogurt",
    "oj":               "orange juice",
    # ── Bare / short forms → reasonable canonical ─────────────────────────────
    "chicken":          "chicken breast",
    "potatoes":         "potato",
    "beans":            "black beans",
    # ── Salmon prep variants ──────────────────────────────────────────────────
    # Only alias when cooking method doesn't materially change the macros.
    # Smoked salmon and raw sashimi are intentionally excluded.
    "grilled salmon":   "salmon",
    "baked salmon":     "salmon",
    "pan seared salmon": "salmon",
    "steamed salmon":   "salmon",
    # ── Potato prep variants ──────────────────────────────────────────────────
    # Profile for "potato" is already baked; roasted is nutritionally equivalent.
    "baked potato":     "potato",
    "roasted potato":   "potato",
    "roasted potatoes": "potato",
    "baked potatoes":   "potato",
    # ── Broccoli prep variants ────────────────────────────────────────────────
    "steamed broccoli": "broccoli",
    "roasted broccoli": "broccoli",
    # ── Egg prep variants (beyond what was already aliased) ───────────────────
    "hard boiled egg":  "egg",
    "hard boiled eggs": "eggs",
    "soft boiled egg":  "egg",
    "soft boiled eggs": "eggs",
    # ── Sweet potato prep variants ────────────────────────────────────────────
    "roasted sweet potato":  "sweet potato",
    "baked sweet potato":    "sweet potato",
    "steamed sweet potato":  "sweet potato",
    # ── Chicken breast prep variants ──────────────────────────────────────────
    # Fried chicken is intentionally excluded — batter and oil change macros.
    "baked chicken":         "chicken breast",
    "pan seared chicken":    "chicken breast",
    "pan seared chicken breast": "chicken breast",
    # ── Turkey prep variants ──────────────────────────────────────────────────
    "grilled turkey breast": "turkey breast",
    "roasted turkey breast": "turkey breast",
    # ── Egg preparation variants ─────────────────────────────────────────────
    "scrambled egg":   "egg",
    "scrambled eggs":  "egg",
    "fried egg":       "egg",
    "fried eggs":      "egg",
    "boiled egg":      "egg",
    "boiled eggs":     "egg",
    "poached egg":     "egg",
    "poached eggs":    "egg",
    # ── Chicken breast preparation variants ──────────────────────────────────
    "grilled chicken breast": "chicken breast",
    "grilled chicken":        "chicken breast",
    "baked chicken breast":   "chicken breast",
    # ── PBJ short-form aliases ────────────────────────────────────────────────
    "pbj sandwich":                 "peanut butter and jelly sandwich",
    "peanut butter jelly sandwich": "peanut butter and jelly sandwich",
    # ── Steak preparation variants ────────────────────────────────────────────
    "beef steak":    "steak",
    "sirloin steak": "steak",
    "ribeye steak":  "steak",
    "ribeye":        "steak",
    "ny strip":      "steak",
    "filet mignon":  "steak",
    # ── Bowl / meal aliases ───────────────────────────────────────────────────
    # "chicken and rice bowl" routes as COMPOSITE_MEAL (" and ") and is caught
    # by _KNOWN_WHOLE_FOODS before decomposition; the alias ensures the profile
    # is found by _profile_for_query when get_nutrition is called with the
    # full phrase.
    "chicken and rice bowl": "chicken rice bowl",
    "chicken and rice":      "chicken rice bowl",
    # ── Condiment short-form aliases ─────────────────────────────────────────
    "whipping cream":        "heavy cream",
    "whipped cream":         "heavy cream",
    "heavy whipping cream":  "heavy cream",
    "full fat cream cheese": "cream cheese",
    "low fat sour cream":    "sour cream",
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
    """Return a canonical generic-food profile for an already-core food query.

    Checks _PROFILE_ALIASES when no direct match exists so that plural forms
    and preparation-method variants resolve to the appropriate base profile
    without duplicating profile entries.
    """
    q = _normalize_query(query)
    profile = _GENERIC_FOOD_PROFILES.get(q)
    if profile is None:
        canonical = _PROFILE_ALIASES.get(q)
        if canonical is not None:
            profile = _GENERIC_FOOD_PROFILES.get(canonical)
    return profile


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
    if "protein shake" in q or ("shake" in q and "protein" in q):
        return {"calories": 200, "protein": 25, "carbs": 15, "fat": 6}
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
    if "hot dog" in q or "hotdog" in q:
        # Costco hot dog + bun ≈ 370 kcal; generic ballpark hot dog ≈ 300 kcal.
        # Costco-specific is caught first since "costco" is in _RESTAURANT_SIGNALS.
        return {"calories": 370, "protein": 15, "carbs": 31, "fat": 21}
    if "burger" in q or "pizza" in q:
        return {"calories": 650, "protein": 30, "carbs": 55, "fat": 35}
    if "fries" in q or "fry" in q:
        return {"calories": 400, "protein": 5,  "carbs": 50, "fat": 18}

    # ── Mexican ───────────────────────────────────────────────────────────────
    if "chipotle" in q:
        # Chipotle-branded bowls/burritos — typical chicken bowl ≈ 680 kcal.
        return {"calories": 680, "protein": 40, "carbs": 72, "fat": 24}
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

    # ── Bowls ─────────────────────────────────────────────────────────────────
    # Generic rice/protein bowls — more conservative than burrito to avoid
    # over-estimating grain-and-protein dishes without sauce.
    if "bowl" in q:
        return {"calories": 580, "protein": 35, "carbs": 65, "fat": 18}

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
    if "protein shake" in q or ("shake" in q and "protein" in q):
        return {"calories": 200, "protein": 25, "carbs": 15, "fat": 6}
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
    # Coffee with a milk/cream add-in (splash, not a full cup).
    # Must precede the generic "coffee" rule so we don't return 0 kcal.
    if "coffee" in q and any(add in q for add in ("milk", "cream", "creamer")):
        return {"calories": 50, "protein": 2, "carbs": 5, "fat": 2}
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

@lru_cache(maxsize=500)
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
    # ── Verified-foods fast path ──────────────────────────────────────────────
    # For GENERIC_FOOD queries (prefer_generic=True) check the offline verified
    # registry before making any USDA network call.  Verified entries return
    # pinned per-100g nutrition instantly; the rest of this function is skipped.
    if prefer_generic:
        _verified = _verified_entry_for_query(_normalize_query(query))
        if _verified is not None:
            return {
                "calories":            _verified.calories_per_100g,
                "protein":             _verified.protein_per_100g,
                "carbs":               _verified.carbs_per_100g,
                "fat":                 _verified.fat_per_100g,
                "is_estimated":        False,
                "source_name":         _verified.source_name,
                "source_type":         _verified.source_type,
                "confidence":          _verified.confidence,
                "serving_description": "per 100g",
            }

    profile = _profile_for_query(query) if prefer_generic else None
    query = profile.search_query if profile is not None else _normalize_query(query)

    # Read the key at call time (not module-level) so that test fixtures or
    # conftest.py that load .env after import still pick up the real key.
    api_key = os.getenv("USDA_API_KEY", "DEMO_KEY")

    params: dict = {
        "query":    query,
        "api_key":  api_key,
        "pageSize": 20,   # Fetch a pool of candidates so we can rank them
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
            # Shake without profile: reject raw RTD per-100g (≈60 kcal) being
            # returned as the whole serving.
            "shake":       100,
            # Bowl queries without profile: reject single-ingredient per-100g
            # results (e.g. 126 kcal/100g frozen entree) as a whole meal.
            "bowl":        200,
            # Coffee with an add-in (milk, cream, etc.): USDA's diluted
            # coffee-with-milk entries are 10–17 kcal/100g — too low to represent
            # a realistic splash serving when returned unscaled.  Reject anything
            # below 35 and fall back to the ~50 kcal rule-based splash estimate.
            "coffee with": 35,
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
