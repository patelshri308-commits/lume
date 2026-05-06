"""
Lume Food Engine — Phase 3 Candidate Scorer
                   (Phase 3b: branded-packaged variant penalty tuning)

Token-based relevance scoring for Open Food Facts text-search candidates.
Shared by packaged_product_service and restaurant_service.

Replaces the previous "first plausible result wins" approach with genuine
multi-candidate ranking so that:
  • "Quest birthday cake bar" picks the birthday-cake variant, not cookie dough
  • "Chipotle chicken bowl" does not return a random chipotle spice product
  • "Diet Coke can" is not penalised for a packaging word that never appears
    in official product names
  • "Hershey bar" returns a standard chocolate bar, not syrup or miniatures
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
# Phase 3b: variant / product-form mismatch penalties
# ---------------------------------------------------------------------------
#
# When a branded query is short and unqualified ("hershey bar", "quest bar"),
# many OFF candidates share the same forward-coverage score because they all
# contain the brand token.  Without additional signal, the tie breaks on scan
# popularity — which often favours a variety pack, syrup, or miniatures over
# the plain standard product.
#
# The terms below are applied as PENALTIES only when the term appears in the
# product name but is ABSENT from the user's query.  If the user explicitly
# asked for "hershey miniatures" or "dark chocolate oreo", the mismatch check
# passes cleanly and no penalty is applied.
#
# Penalty magnitudes:
#   20   wrong product form (syrup, powder, spread — fundamentally not a bar)
#   15   size variant that changes the serving unit (miniatures, miniature)
#   12   size variant — smaller than standard (minis)
#   10   multi-pack / variety (variety pack, assorted)
#    8   lesser size variants (snack size, fun size, bite size, king size)
#    8   ingredient variant (almond) — lighter, may still be right form
#    6   flavour variant as compound phrase (dark chocolate, white chocolate)
#        — compound check prevents penalising "dark" as a lone colour word
#
# All checks are substring matches on the lowercased product name so that
# multi-word phrases ("variety pack", "dark chocolate") work naturally.

_VARIANT_MISMATCH_TERMS: dict[str, int] = {
    # Wrong product form — user asked for a bar/snack, not a liquid or powder
    "syrup":            20,
    "powder":           20,
    "spread":           20,
    "baking":           18,
    "cocoa":            15,   # "baking cocoa", "cocoa powder" — not a bar
    "hot cocoa":        15,   # dry mix, not a candy bar
    "baking chips":     18,   # baking ingredient, not a snack
    "extract":          18,   # flavouring extract
    # Size variants — user did not ask for a reduced-size portion
    "miniatures":       15,
    "miniature":        15,
    "minis":            12,
    "bites":            10,   # e.g. "Hershey's Bites" — smaller form
    "snack size":        8,
    "fun size":          8,
    "bite size":         8,
    "king size":         8,
    "thins":             6,   # thinner/lighter version (Oreo Thins, etc.)
    # Multi-pack / variety — user asked for a single standard item
    "variety pack":     10,
    "multipack":        10,
    "assorted":         10,
    "mixed":             5,   # "mixed bag" style multi-flavour packs
    # Ingredient / flavour variants — lighter penalty; user may still want these
    # if they included the term in their query (check skips them if so)
    "almond":            8,
    "dark chocolate":    6,
    "white chocolate":   6,
    "sugar free":        6,   # diet variant when user didn't ask for it
}


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

    Brand token bonus  +20 (once) when any meaningful query token appears in
                       the brand field specifically — not just in the combined
                       text.  Rewards "Quest birthday cake bar" when the product
                       brand is "Quest Nutrition" and "quest" is a query token.
                       Raised from +15 → +20 in Phase 3b so that the primary
                       brand identity token contributes more to short queries
                       where coverage ties would otherwise break on scan rank.

    Excess token penalty  −4 per meaningful product-name token (that is NOT in
                          the query) beyond the first three "extras".  Penalises
                          products that are far more specific than the query,
                          e.g. preferring "Oreo Thins" over "Oreo Thins Chocolate
                          Sandwich Cookies with Extra Creme" for query "Oreo thins".

    Variant mismatch penalty  (Phase 3b)
                          Applied when a term from _VARIANT_MISMATCH_TERMS
                          appears in the product name but NOT in the query.
                          Prevents wrong-form products (syrups, powders,
                          miniatures, variety packs) from winning ties with
                          the plain standard product on scan-popularity alone.
    """
    q_lower     = query.lower()
    name_lower  = (product_name or "").lower()
    brand_lower = (brand or "").lower()
    combined    = f"{brand_lower} {name_lower}".strip()

    combined_tokens = set(_tokenize(combined))
    query_tokens    = _meaningful_tokens(q_lower)

    if not query_tokens:
        return 0

    # ── Exact / prefix name match bonus ─────────────────────────────────────
    # When the product name (or brand+name) is identical to the query — or
    # starts with the query — reward it strongly so it beats partial matches
    # even when the coverage tier would tie.
    #  +25: product name is an exact or case-only match for the query
    #  +12: product name starts with the full query text (query is a prefix)
    # The check is done on lowercased strings to be case-insensitive.
    if name_lower.strip() == q_lower.strip():
        score = 25   # override — set base, coverage bonuses still add below
    elif combined.strip() == q_lower.strip():
        score = 25
    elif name_lower.startswith(q_lower.strip()):
        score += 12

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
    # Raised to +20 (was +15) so exact brand matches contribute more weight
    # on short queries where multiple candidates tie on coverage alone.
    brand_tokens = set(_tokenize(brand_lower))
    if brand_tokens:
        for qt in query_tokens:
            if qt in brand_tokens:
                score += 20
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

    # ── Variant / product-form mismatch penalty ───────────────────────────────
    # Only fires when the mismatch term is absent from the query, so explicitly
    # requested variants ("hershey miniatures", "dark chocolate oreo") are never
    # penalised.  Substring matching handles multi-word phrases naturally.
    for term, penalty in _VARIANT_MISMATCH_TERMS.items():
        if term not in q_lower and term in name_lower:
            score -= penalty

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
