"""
Lume Food Engine — Phase 3 Candidate Scorer

Token-based relevance scoring for Open Food Facts text-search candidates.
Shared by packaged_product_service and restaurant_service.

Replaces the previous "first plausible result wins" approach with genuine
multi-candidate ranking so that:
  • "Quest birthday cake bar" picks the birthday-cake variant, not cookie dough
  • "Chipotle chicken bowl" does not return a random chipotle spice product
  • "Diet Coke can" is not penalised for a packaging word that never appears
    in official product names
"""
from __future__ import annotations
import re


# ---------------------------------------------------------------------------
# Token filter sets
# ---------------------------------------------------------------------------

# Generic filler words that carry no food-identity information.
_SKIP_WORDS: frozenset[str] = frozenset({
    "the", "a", "an", "of", "for", "and", "or", "with",
    "by", "in", "on", "at", "to", "from", "is", "its",
})

# Packaging / serving-context words that users include for clarity but that
# rarely appear verbatim in official product names.  Filtering them prevents
# "Diet Coke can" losing coverage credit for the word "can" not appearing in
# OFF's "Diet Coke" entry.
_PACKAGING_WORDS: frozenset[str] = frozenset({
    "can", "cans",
    "bottle", "bottles",
    "pack", "packs",
    "bag", "bags",
    "box", "boxes",
    "packet", "packets",
    "serving", "servings",
    "oz", "ounce", "ounces",
    "ml", "liter", "liters", "litre", "litres",
    "fl",
})

_MIN_TOKEN_LEN: int = 2


# ---------------------------------------------------------------------------
# Public scorer
# ---------------------------------------------------------------------------

def score_candidate(product_name: str, brand: str | None, query: str) -> int:
    """
    Score a single Open Food Facts product against a user's typed query.

    Returns an integer — higher is better, negative means likely wrong product.

    Score components
    ────────────────
    Forward coverage  base score from the fraction of meaningful query tokens
                      found anywhere in "brand + product name":
                        100% covered → +60   (all tokens present)
                         ≥75% covered → +35
                         ≥50% covered → +12   (partial match)
                         ≥25% covered → −10   (less than half found)
                          <25% covered → −30   (almost nothing matches)

    Brand token bonus  +15 (once) when any meaningful query token appears in
                       the brand field specifically — not just in the combined
                       text.  Rewards "Quest birthday cake bar" when the product
                       brand is "Quest Nutrition" and "quest" is a query token.

    Excess token penalty  −4 per meaningful product-name token (that is NOT in
                          the query) beyond the first three "extras".  Penalises
                          products that are far more specific than the query,
                          e.g. preferring "Oreo Thins" over "Oreo Thins Chocolate
                          Sandwich Cookies with Extra Creme" for query "Oreo thins".
    """
    q_lower     = query.lower()
    name_lower  = (product_name or "").lower()
    brand_lower = (brand or "").lower()
    combined    = f"{brand_lower} {name_lower}".strip()

    combined_tokens = set(_tokenize(combined))
    query_tokens    = _meaningful_tokens(q_lower)

    if not query_tokens:
        return 0

    # ── Forward coverage ─────────────────────────────────────────────────────
    n_matched = sum(1 for t in query_tokens if t in combined_tokens)
    coverage  = n_matched / len(query_tokens)

    if coverage >= 1.0:
        score = 60
    elif coverage >= 0.75:
        score = 35
    elif coverage >= 0.50:
        score = 12
    elif coverage >= 0.25:
        score = -10
    else:
        score = -30

    # ── Brand token bonus ────────────────────────────────────────────────────
    brand_tokens = set(_tokenize(brand_lower))
    if brand_tokens:
        for qt in query_tokens:
            if qt in brand_tokens:
                score += 15
                break   # at most once

    # ── Excess token penalty ─────────────────────────────────────────────────
    query_token_set  = set(query_tokens)
    name_only_extras = [
        t for t in _tokenize(name_lower)
        if len(t) > _MIN_TOKEN_LEN
        and t not in _SKIP_WORDS
        and t not in _PACKAGING_WORDS
        and t not in query_token_set
    ]
    excess = max(0, len(name_only_extras) - 3)
    score -= excess * 4

    return score


# ---------------------------------------------------------------------------
# Internal helpers  (also importable by services if needed)
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> list[str]:
    """Return all word tokens from text, lowercased."""
    return re.findall(r"\b\w+\b", text.lower())


def _meaningful_tokens(text: str) -> list[str]:
    """
    Return tokens that carry genuine food-identity meaning: length > MIN,
    not a stop word, not a packaging/context descriptor.
    """
    return [
        t for t in _tokenize(text)
        if len(t) > _MIN_TOKEN_LEN
        and t not in _SKIP_WORDS
        and t not in _PACKAGING_WORDS
    ]
