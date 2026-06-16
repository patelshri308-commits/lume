"""
Lume Food Engine — Phase 1 Query Parser

Extracts structured components from a raw food query string before
classification or source lookup.  A pure data-transformation step with
no external calls or side effects.

The output ParsedQuery carries:
  - clean          lowercased, whitespace-stripped original text
  - quantity       leading numeric quantity (1.0 if absent)
  - unit           unit word that followed the quantity, if present
  - size_modifier  size word found at the start of the food phrase
  - with_components  items extracted from "with X [and Y]" clauses
  - base_modifier  "on wheat / on rye / …" bread/base qualifier
  - is_barcode_like  True for 8–14 digit strings (UPC/EAN)
  - core_food      food text after stripping qty, unit, modifiers
                   (does NOT discard "with" clauses — see with_components)

Important: the full query is always preserved in `clean`.  Only
`core_food` is stripped.  This lets the router choose which form to
pass to each source service.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Lookup tables
# ---------------------------------------------------------------------------

_NUMBER_WORDS: dict[str, float] = {
    "a": 1.0, "an": 1.0,
    "one": 1.0, "two": 2.0, "three": 3.0, "four": 4.0, "five": 5.0,
    "six": 6.0, "seven": 7.0, "eight": 8.0, "nine": 9.0, "ten": 10.0,
    "half": 0.5, "quarter": 0.25,
}

_UNITS: frozenset[str] = frozenset({
    "oz", "ounce", "ounces",
    "g", "gram", "grams",
    "kg", "kilogram", "kilograms",
    "lb", "lbs", "pound", "pounds",
    "cup", "cups",
    "tbsp", "tablespoon", "tablespoons",
    "tsp", "teaspoon", "teaspoons",
    "ml", "milliliter", "milliliters",
    "l", "liter", "liters",
    "slice", "slices",
    "strip", "strips",
    "piece", "pieces",
    "serving", "servings",
    "scoop", "scoops",
    "can", "cans",
    "bottle", "bottles",
    "packet", "packets",
    "bar", "bars",
    "fl oz",
})

_SIZE_MODIFIERS: frozenset[str] = frozenset({
    "small", "medium", "large", "grande", "venti", "tall",
    "mini", "jumbo", "regular", "extra large", "extra-large",
    "king size", "king-size",
})

# "on X" bread/base qualifiers that indicate a constructed item
_BASE_MODIFIER_RE = re.compile(
    r"\s+on\s+"
    r"(wheat|rye|sourdough|white\s*bread|whole\s*wheat|multigrain|pita|wrap|toast|white)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Output type
# ---------------------------------------------------------------------------

@dataclass
class ParsedQuery:
    """Structured representation of a food query after parsing."""
    raw:              str
    clean:            str            # lowercased, whitespace-stripped original
    quantity:         float = 1.0
    unit:             Optional[str] = None
    size_modifier:    Optional[str] = None
    with_components:  list[str] = field(default_factory=list)
    base_modifier:    Optional[str] = None
    is_barcode_like:  bool = False
    core_food:        str = ""


# ---------------------------------------------------------------------------
# Pre-compiled patterns
# ---------------------------------------------------------------------------

_NUM_WORD_ALT = "|".join(
    re.escape(k) for k in sorted(_NUMBER_WORDS.keys(), key=len, reverse=True)
)
_QTY_RE = re.compile(
    r"^(\d+\.?\d*|" + _NUM_WORD_ALT + r")\s+",
    re.IGNORECASE,
)

_UNIT_ALT = "|".join(
    re.escape(u) for u in sorted(_UNITS, key=len, reverse=True)
)
_UNIT_RE = re.compile(
    r"^(" + _UNIT_ALT + r")\s+",
    re.IGNORECASE,
)

_SIZE_ALT = "|".join(
    re.escape(s) for s in sorted(_SIZE_MODIFIERS, key=len, reverse=True)
)
_SIZE_RE = re.compile(
    r"^(" + _SIZE_ALT + r")\s+",
    re.IGNORECASE,
)

_COMPACT_QTY_UNIT_RE = re.compile(
    r"^(\d+\.?\d*)\s*(" + _UNIT_ALT + r")\s+",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse(raw: str) -> ParsedQuery:
    """
    Parse a raw food query string into a ParsedQuery.

    Parsing is purely additive — information is only extracted and stored,
    never silently discarded.  The full original text is always accessible
    via pq.clean; pq.core_food is the stripped form used for classification.
    """
    clean = raw.strip().lower()
    pq = ParsedQuery(raw=raw, clean=clean)

    # ── Barcode: 8–14 digit string (EAN-8, EAN-13, UPC-A/E) ─────────────────
    digits_only = re.sub(r"\s", "", clean)
    if digits_only.isdigit() and 8 <= len(digits_only) <= 14:
        pq.is_barcode_like = True
        pq.core_food = clean
        return pq

    remaining = clean

    # ── Leading compact measurement, e.g. "100g chicken" ─────────────────────
    m = _COMPACT_QTY_UNIT_RE.match(remaining)
    if m:
        pq.quantity = float(m.group(1))
        pq.unit = m.group(2).lower()
        remaining = remaining[m.end():]
    else:
        # ── Leading quantity (decimal, integer, or English number word) ──────
        m = _QTY_RE.match(remaining)
        if m:
            token = m.group(1).lower()
            try:
                pq.quantity = float(token)
            except ValueError:
                pq.quantity = _NUMBER_WORDS.get(token, 1.0)
            remaining = remaining[m.end():]

        # ── Unit following the quantity ───────────────────────────────────────
        m = _UNIT_RE.match(remaining)
        if m:
            pq.unit = m.group(1).lower()
            remaining = remaining[m.end():]

    # ── Size modifier (prefix only, before the food name) ────────────────────
    m = _SIZE_RE.match(remaining)
    if m:
        pq.size_modifier = m.group(1).lower()
        remaining = remaining[m.end():]

    # ── "on X" base modifier (e.g. "on wheat", "on rye") ─────────────────────
    m = _BASE_MODIFIER_RE.search(remaining)
    if m:
        pq.base_modifier = m.group(0).strip()
        remaining = remaining[: m.start()] + remaining[m.end() :]

    # ── "with …" components ───────────────────────────────────────────────────
    # Split on " with " to separate the main food from its additions.
    # The full clean query is preserved; we only extract the add-ins for
    # use in classification.  The router decides which form to pass onward.
    with_parts = re.split(r"\s+with\s+", remaining, flags=re.IGNORECASE)
    if len(with_parts) > 1:
        remaining = with_parts[0].strip()
        add_ins_text = " and ".join(with_parts[1:])
        pq.with_components = [
            c.strip()
            for c in re.split(r"\s+and\s+", add_ins_text)
            if c.strip()
        ]

    # Strip a leading "of" preposition left over from "N unit of food"
    # e.g. "a cup of oatmeal" → after qty+unit: "of oatmeal" → "oatmeal"
    remaining = re.sub(r"^of\s+", "", remaining)
    pq.core_food = remaining.strip()
    return pq
