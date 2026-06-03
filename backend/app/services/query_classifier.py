"""
Lume Food Engine — Phase 1 Query Classifier

Maps a ParsedQuery to a QueryClass.  Pure function — no external calls,
no state, no side effects.

QueryClass determines the source routing order in query_router.py.

Classification precedence
─────────────────────────
1. BARCODE          — barcode-like numeric input
2. RESTAURANT_ITEM  — recognised chain/restaurant brand signal in the query
3. BRANDED_PACKAGED — recognised packaged-food brand signal in the query
4. COMPOSITE_MEAL   — "with" add-ins, "and"-connected multi-item structure,
                      or constructed item with a bread/base modifier
5. AMBIGUOUS        — single high-variance category word with no qualifying
                      context (brand, "with", descriptive modifier, etc.)
6. GENERIC_FOOD     — default for everything else (specific single-ingredient
                      foods, whole foods, plain items)
"""
from __future__ import annotations

from enum import Enum

from app.services.query_parser import ParsedQuery


# ---------------------------------------------------------------------------
# Public enum
# ---------------------------------------------------------------------------

class QueryClass(Enum):
    BARCODE          = "BARCODE"
    GENERIC_FOOD     = "GENERIC_FOOD"
    BRANDED_PACKAGED = "BRANDED_PACKAGED"
    RESTAURANT_ITEM  = "RESTAURANT_ITEM"
    COMPOSITE_MEAL   = "COMPOSITE_MEAL"
    AMBIGUOUS        = "AMBIGUOUS"


# ---------------------------------------------------------------------------
# Signal sets
# ---------------------------------------------------------------------------

# Fast-food / chain restaurant brand keywords.
# Each entry is checked as a substring of the lowercased query.
_RESTAURANT_SIGNALS: frozenset[str] = frozenset({
    "mcdonald", "mcdonalds",
    "chipotle",
    "starbucks",
    "burger king",
    "wendys", "wendy's",
    "taco bell",
    "chick-fil-a", "chick fil a", "chickfila",
    "subway",
    "dominos", "domino's",
    "kfc",
    "pizza hut",
    "panera",
    "dunkin",
    "popeyes",
    "sonic",
    "whataburger",
    "in-n-out", "in n out",
    "five guys",
    "shake shack",
    "panda express",
    "olive garden",
    "applebees", "applebee's",
    "ihop",
    "cheesecake factory",
    "buffalo wild wings",
    "outback",
    "red lobster",
    "texas roadhouse",
    "dennys", "denny's",
    "jack in the box",
    "carl's jr", "carls jr",
    "del taco",
    "wingstop",
    "raising cane",
    "raising canes",
    "zaxby",
    "bojangles",
})

# Packaged / branded product name keywords.
# Distinct from restaurant brands — these are consumer packaged goods.
#
# NOTE (Phase 1): Queries that match any signal here are routed to Open Food
# Facts (packaged_product_service) instead of USDA, which has no branded data.
# Add new brands here whenever a common branded query misroutes to USDA.
_PACKAGED_SIGNALS: frozenset[str] = frozenset({
    # ── Protein / energy bars ─────────────────────────────────────────────────
    "quest",
    "clif", "rxbar", "larabar", "kind bar", "rx bar",
    "built bar",
    "think thin",
    "one protein bar",
    "fiber one",
    "kind protein",
    "atkins bar",
    "premier protein",
    "nugo",
    "oatmega",
    "fulfil",

    # ── Chocolate / candy bars ────────────────────────────────────────────────
    "hershey",                            # Hershey's bar, kisses, nuggets
    "m&m", "m&ms",                        # M&M's (plain, peanut, etc.)
    "milky way",
    "3 musketeers",
    "butterfinger",
    "baby ruth",
    "twix", "snickers", "kit kat",
    "reese's", "reese",                   # Reese's cups / pieces
    "york peppermint",
    "almond joy", "mounds",
    "100 grand",
    "skor",
    "heath bar",
    "take 5",
    "whatchamacallit",

    # ── Gummies / hard candy ──────────────────────────────────────────────────
    "skittles",
    "starburst",
    "jolly rancher",
    "nerds",
    "sour patch",
    "swedish fish",
    "haribo",
    "trolli",

    # ── Cookies / crackers ────────────────────────────────────────────────────
    "oreo",
    "chips ahoy",
    "nutter butter",
    "nilla wafer",
    "golden oreo",
    "ritz",
    "wheat thins",
    "triscuit",
    "cheez-it", "cheez it",
    "goldfish",
    "nabisco",

    # ── Chips / crisps ────────────────────────────────────────────────────────
    "doritos",
    "pringles",
    "lays", "lay's",
    "cheetos",
    "fritos",
    "ruffles",
    "sun chips",
    "funyuns",
    "cape cod chips",

    # ── Cereals ───────────────────────────────────────────────────────────────
    "cheerios",
    "frosted flakes",
    "rice krispies",
    "lucky charms",
    "froot loops",
    "cocoa puffs",
    "cap'n crunch", "capn crunch",
    "cocoa krispies",
    "special k",
    "nature valley",
    "nutri grain",

    # ── Spreads / condiments ──────────────────────────────────────────────────
    "nutella",
    "justin's",
    "rxbar nut butter",

    # ── Breakfast / frozen ────────────────────────────────────────────────────
    "pop tart", "pop-tart",
    "eggo",
    "toaster strudel",

    # ── Beverages ─────────────────────────────────────────────────────────────
    "gatorade",
    "powerade",
    "red bull",
    "monster energy",
    "diet coke", "coke zero", "pepsi zero",
    "vitaminwater",
    "fairlife",
    "celsius",
    "liquid iv", "liquid i.v.",
    "bodyarmor", "body armor",
    "prime hydration",

    # ── Dairy / protein drinks ────────────────────────────────────────────────
    "muscle milk",
    "core power",
    "boost",
    "ensure",

    # ── Other snacks ──────────────────────────────────────────────────────────
    "smartfood",
    "pirate's booty",
    "rice cakes",                         # Quaker brand rice cakes
    "quaker",
})

# Well-known restaurant menu items that do not contain a brand name in the
# query itself (e.g. "big mac" is McDonald's but users omit the brand).
# These supplement the brand-name signals above.
_RESTAURANT_MENU_SIGNALS: frozenset[str] = frozenset({
    # McDonald's
    "big mac", "mcnuggets", "quarter pounder", "mcflurry", "egg mcmuffin",
    # Burger King
    "whopper",
    # Wendy's
    "frosty", "baconator",
    # Chick-fil-A
    "chick-fil-a sandwich", "chickfila sandwich",
    # Taco Bell
    "chalupa", "crunchwrap", "gordita",
    # Starbucks
    "frappuccino",   # note: also catches generic frappuccinos fine
    # Chipotle
    "sofritas",
    # Shake Shack
    "shackburger",
    # Generic fast-food item names distinctive enough to imply a chain
    "double double",   # In-N-Out
})

# Constructed-item words: when combined with a base_modifier (e.g. "on wheat")
# these signal a composite meal even without an explicit "with" clause.
_CONSTRUCTED_ITEM_WORDS: frozenset[str] = frozenset({
    "sandwich", "wrap", "bowl", "sub", "hoagie",
    "burger", "plate", "combo", "blt", "club",
})

# High-variance category words that, in isolation and without qualifying
# context, cannot be confidently routed to a single source.
# Examples per the architecture spec: sandwich, smoothie, pasta, burrito.
_AMBIGUOUS_SIGNALS: frozenset[str] = frozenset({
    "sandwich",
    "smoothie",
    "pasta",
    "burrito",
    "wrap",
    "bowl",
    "salad",
    "soup",
    "stew",
    "casserole",
    "hash",
    "scramble",
    "noodles",
    "stir fry", "stir-fry",
    "curry",
    "chili",
    "pizza",
    "tacos",
})


# ---------------------------------------------------------------------------
# Public classifier
# ---------------------------------------------------------------------------

def classify(parsed: ParsedQuery) -> QueryClass:
    """
    Return the QueryClass for a ParsedQuery.

    Signal matching is intentionally conservative at each step so that
    misclassifications fail toward GENERIC_FOOD rather than toward wrong
    branded sources.
    """
    # 1. Barcode — always wins
    if parsed.is_barcode_like:
        return QueryClass.BARCODE

    clean = parsed.clean

    # 2. Restaurant signal — brand name OR well-known menu item
    for signal in _RESTAURANT_SIGNALS:
        if signal in clean:
            return QueryClass.RESTAURANT_ITEM
    for signal in _RESTAURANT_MENU_SIGNALS:
        if signal in clean:
            return QueryClass.RESTAURANT_ITEM

    # 3. Packaged brand signal
    for signal in _PACKAGED_SIGNALS:
        if signal in clean:
            return QueryClass.BRANDED_PACKAGED

    # 4. Composite meal
    if _is_composite(parsed):
        return QueryClass.COMPOSITE_MEAL

    # 5. Ambiguous category
    if _is_ambiguous(parsed):
        return QueryClass.AMBIGUOUS

    # 6. Default
    return QueryClass.GENERIC_FOOD


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------

_GENERIC_SINGLE_WORD_OVERRIDES: frozenset[str] = frozenset({
    "pasta",
})

def _is_composite(parsed: ParsedQuery) -> bool:
    """
    Return True if the query describes a multi-component meal.

    Triggers:
    ─────────
    a) Parser found "with" add-ins  (e.g. "coffee with milk", "oatmeal with fruit")
    b) core_food contains " and "   (e.g. "eggs and toast", "chicken and rice")
    c) A base_modifier is present AND the core food is a constructed item type
       (e.g. "turkey sandwich on wheat" — base_modifier="on wheat",
        core_food contains "sandwich")
    """
    # (a) "with" add-ins detected by the parser
    if parsed.with_components:
        return True

    core = parsed.core_food

    # (b) "and" connecting multiple food items
    if " and " in core:
        return True

    # (c) bread/base modifier on a constructed item
    if parsed.base_modifier:
        core_lower = core.lower()
        for word in _CONSTRUCTED_ITEM_WORDS:
            if word in core_lower:
                return True

    return False


def _is_ambiguous(parsed: ParsedQuery) -> bool:
    """
    Return True if the query is a single high-variance category word
    with no qualifying context.

    "Qualifying context" means:
    - "with" add-ins        (e.g. "smoothie with banana" → COMPOSITE_MEAL instead)
    - base_modifier         (e.g. "wrap on wheat" → COMPOSITE_MEAL instead)
    - More than 2 core words  (e.g. "chicken burrito bowl" is specific enough)
    - A size modifier or unit  (gives partial nutritional context)

    Short unqualified queries — "sandwich", "burrito", "pasta" — are AMBIGUOUS.
    Qualified ones — "chicken burrito", "veggie pasta" — are GENERIC_FOOD.
    """
    # "with" or base modifier provides enough context
    if parsed.with_components or parsed.base_modifier:
        return False

    # A unit or size modifier provides some context
    if parsed.unit or parsed.size_modifier:
        return False

    core_words = parsed.core_food.lower().split()

    if parsed.core_food.lower() in _GENERIC_SINGLE_WORD_OVERRIDES:
        return False

    # More than 2 core words → enough descriptive context to route confidently
    if len(core_words) > 2:
        return False

    if len(core_words) == 1:
        # Single word: ambiguous only if it is itself a high-variance category
        # e.g. "sandwich", "burrito", "smoothie" → AMBIGUOUS
        return core_words[0] in _AMBIGUOUS_SIGNALS

    # 2 words: only ambiguous if BOTH words are in the signal set.
    # "chicken burrito" has a qualifier ("chicken") so it is GENERIC_FOOD.
    # "burrito bowl" has two ambiguous words so it stays AMBIGUOUS.
    return all(w in _AMBIGUOUS_SIGNALS for w in core_words)
