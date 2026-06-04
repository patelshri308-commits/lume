"""
Lume Food Engine — Phase 4 Composite Meal Service

Decomposes a COMPOSITE_MEAL-class query into individual food components,
resolves each component's nutrition via the USDA service, and aggregates
the totals.

Decomposition strategy
──────────────────────
Given a ParsedQuery classified as COMPOSITE_MEAL, components are extracted
from three sources (in order):

1. "and"-splits in core_food
       "2 eggs and toast"       →  ["2 eggs", "toast"]
       The parsed quantity+unit is re-attached to the FIRST split component
       only — the "2" in "2 eggs and toast" belongs to the eggs, not the toast.

2. "with" add-ins  (parsed.with_components)
       "coffee with milk and sugar"
           →  core: "coffee",  add-ins: ["milk", "sugar"]
       Each add-in inherits no quantity from the parent; if it contains its
       own quantity ("with 2 tbsp peanut butter") that is parsed independently.

3. Bread/base modifier  (parsed.base_modifier)
       Treatment depends on whether the core food already includes bread:

       • Core contains a constructed-item word (sandwich, wrap, sub, burger …)
         →  fold the base modifier IN as a qualifier to the lookup query:
            "turkey sandwich on wheat" → single lookup "turkey sandwich on wheat"

       • Core does NOT contain a constructed-item word AND an "and"-split
         happened → add the bread as a separate nutrition component:
            "egg salad and lettuce on wheat" → ["egg salad", "lettuce", "wheat bread"]

Each component string is individually re-parsed so embedded quantities
("2 tbsp peanut butter", "a banana") are correctly extracted and forwarded
to get_nutrition.  The parent ParsedQuery's size_modifier (e.g. "large") is
applied to the first component only when the component itself has no
size_modifier of its own.

Confidence behaviour
────────────────────
The returned dict carries a ``_decomposition_meta`` key with:
  component_count   total components attempted
  resolved_count    components that returned a result (even estimated)
  failed_count      components whose lookup raised an exception
  any_estimated     True if any component used the rule-based fallback

The router uses this to derive a precise confidence value and MUST pop the
key before returning to the frontend.
"""
from __future__ import annotations

import re

from app.services.query_parser import parse as _parse
from app.services.nutrition_service import get_nutrition


# ---------------------------------------------------------------------------
# Known whole-food phrases — skip decomposition
# ---------------------------------------------------------------------------

# Queries in this set are recognised single food items whose canonical name
# happens to contain "and" or a base_modifier that would otherwise trigger
# decomposition.  They are looked up as a whole food via get_nutrition rather
# than being split into parts.
#
# Keys are lowercase-stripped full query strings.  When the composite router
# calls decompose_composite for one of these queries, the fast-path fires
# before _build_components so that no fragmentation occurs.
#
# Do NOT add queries here that genuinely describe two separate foods
# (e.g. "eggs and toast" — that SHOULD decompose).  Only add phrases where
# fragmentation produces a clearly wrong result.
_KNOWN_WHOLE_FOODS: frozenset[str] = frozenset({
    # Sandwiches (Phase 9B)
    "peanut butter and jelly sandwich",
    "pbj sandwich",
    "peanut butter jelly sandwich",
    "peanut butter sandwich",
    "grilled cheese sandwich",
    "turkey sandwich",
    "turkey sandwich on wheat",
    "turkey sandwich on rye",
    # Meal bowls (Phase 9C)
    "chicken and rice bowl",
    "chicken rice bowl",
    # Coffee add-ins (Phase 9D) — prevent decomposition from adding a full cup
    # of milk (244 g → ~150 kcal) instead of a realistic 30 g splash.
    "coffee with milk",
    "coffee with cream",
    # NOTE: "salad with chicken" is intentionally NOT in this set.
    # Composite decomposition (salad ≈ 30 kcal + chicken ≈ 165 kcal ≈ 200 kcal)
    # stays within the Phase 8D acceptance range (168–712) and avoids the risk
    # of USDA matching a high-fat prepared chicken salad (≥250 kcal/100g) and
    # over-scaling it against a full-meal default_grams.
})


# ---------------------------------------------------------------------------
# Lookup tables
# ---------------------------------------------------------------------------

# Maps the keyword from a parsed base_modifier to a concrete food name.
# The base_modifier string arrives as "on wheat", "on rye", etc. — the
# "on " prefix is stripped before the dict lookup.
_BASE_TO_FOOD: dict[str, str] = {
    "wheat":        "wheat bread",
    "whole wheat":  "whole wheat bread",
    "white":        "white bread",
    "white bread":  "white bread",
    "rye":          "rye bread",
    "sourdough":    "sourdough bread",
    "multigrain":   "multigrain bread",
    "pita":         "pita bread",
    "wrap":         "flour tortilla",
    "toast":        "toast",
}

# When core_food contains any of these words, the bread/base is already
# part of the item's nutrition — do not add it again as a separate component.
_INCLUDES_BREAD: frozenset[str] = frozenset({
    "sandwich", "wrap", "sub", "hoagie", "burger", "blt", "club",
})


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fmt_qty(qty: float) -> str:
    """Format a float quantity cleanly: 2.0 → '2',  2.5 → '2.5'."""
    return str(int(qty)) if qty == int(qty) else str(qty)


def _base_modifier_to_food(base_modifier: str) -> str | None:
    """
    Convert a ParsedQuery base_modifier like "on wheat" or "on rye" to a
    concrete food lookup string.  Returns None if the key is unrecognised.
    """
    key = re.sub(r"^on\s+", "", base_modifier.lower()).strip()
    return _BASE_TO_FOOD.get(key)


def _core_includes_bread(core_food: str) -> bool:
    """Return True if core_food describes an item that already includes bread."""
    lower = core_food.lower()
    return any(w in lower for w in _INCLUDES_BREAD)


def _build_components(parsed) -> list[str]:
    """
    Build a flat list of component query strings from a ParsedQuery.

    The resulting strings can each be passed through _parse + get_nutrition
    independently; any embedded quantity/unit/size information is preserved
    so that per-component re-parsing extracts it correctly.
    """
    components: list[str] = []
    core = parsed.core_food.strip()

    def _reattach_qty(text: str, is_first: bool) -> str:
        """
        Prepend the parent quantity+unit to the first component string.
        Example: parsed.quantity=2.0, parsed.unit="cups", text="rice"
                 → "2 cups rice"
        """
        if is_first and parsed.quantity != 1.0:
            qty_str = _fmt_qty(parsed.quantity)
            prefix  = f"{qty_str} {parsed.unit}" if parsed.unit else qty_str
            return f"{prefix} {text}"
        return text

    # ── 1. core_food — split on " and " or treat as single component ──────────
    if " and " in core:
        parts = [p.strip() for p in core.split(" and ") if p.strip()]

        # Fold base_modifier into the FIRST part as a qualifier.
        # "eggs and toast on wheat" → parts[0] = "eggs on wheat" (edge case, safe).
        # In the common case ("turkey sandwich on wheat") " and " won't be present.
        if parts and parsed.base_modifier:
            parts[0] = f"{parts[0]} {parsed.base_modifier}"

        for i, part in enumerate(parts):
            components.append(_reattach_qty(part, i == 0))

    else:
        # Single core food.
        # If core contains a constructed-item word (sandwich, wrap …), fold the
        # base modifier in as a query qualifier: "turkey sandwich on wheat".
        # Otherwise, if a base modifier exists, it will be added separately below.
        if parsed.base_modifier and _core_includes_bread(core):
            core_query = f"{core} {parsed.base_modifier}".strip()
        else:
            core_query = core
        components.append(_reattach_qty(core_query, True))

    # ── 2. "with" add-ins — each parsed independently, no quantity inherited ──
    for comp in parsed.with_components:
        comp = comp.strip()
        if comp:
            components.append(comp)

    # ── 3. Bread/base modifier as a SEPARATE component ────────────────────────
    # Only when:
    #   • an "and"-split happened  (so the modifier wasn't folded in above)
    #   • AND the core food does NOT already include bread
    # Example: "egg salad and lettuce on wheat" → add "wheat bread"
    if (
        " and " in parsed.core_food
        and parsed.base_modifier
        and not _core_includes_bread(core)
    ):
        food_name = _base_modifier_to_food(parsed.base_modifier)
        if food_name:
            components.append(food_name)

    return components


def _resolve_component(
    text: str,
    parent_size_modifier: str | None = None,
    is_first: bool = False,
) -> dict:
    """
    Parse and look up nutrition for a single component string.

    The component is re-parsed so that embedded quantities/units/size words
    override the parent's values.  The parent's size_modifier is applied to
    the first component only when the component itself carries none.
    """
    comp_parsed = _parse(text)
    food_query  = comp_parsed.core_food if comp_parsed.core_food else text

    # First component inherits the parent size_modifier if it has none of its own.
    size_mod = comp_parsed.size_modifier or (parent_size_modifier if is_first else None)

    return get_nutrition(
        food_query,
        quantity=comp_parsed.quantity,
        unit=comp_parsed.unit,
        size_modifier=size_mod,
    )


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def decompose_composite(parsed, original_query: str) -> dict:
    """
    Decompose a COMPOSITE_MEAL ParsedQuery into components, resolve each
    component, and return aggregated nutrition.

    Return shape
    ────────────
    Standard Lume nutrition dict plus an extra ``_decomposition_meta`` key
    (dict) that the router uses to derive confidence.  The router MUST pop
    this key before forwarding the result to the frontend.

    Fallback behaviour
    ──────────────────
    • If _build_components returns an empty list, a full-query get_nutrition
      call is made and the result is flagged as a single-component fallback.
    • If every component lookup raises an exception, the same fallback is used.
    • In both cases meta["resolved_count"] == 0 signals a full fallback.
    """
    # ── Known whole-food fast-path ────────────────────────────────────────────
    # Check before building components so that these phrases are never split.
    normalized = original_query.lower().strip()
    if normalized in _KNOWN_WHOLE_FOODS:
        result = get_nutrition(normalized, prefer_generic=True)
        return {
            **result,
            "source_type": "composite_meal",
            "_decomposition_meta": {
                "component_count": 1,
                "resolved_count":  1,
                "failed_count":    0,
                "any_estimated":   result.get("is_estimated", True),
            },
        }

    components = _build_components(parsed)

    # ── Zero-component edge case ──────────────────────────────────────────────
    if not components:
        result = get_nutrition(original_query)
        return {**result, "_decomposition_meta": {
            "component_count": 0,
            "resolved_count":  0,
            "failed_count":    0,
            "any_estimated":   result.get("is_estimated", True),
        }}

    # ── Resolve each component ────────────────────────────────────────────────
    resolved: list[dict] = []
    failed_count  = 0
    any_estimated = False

    for i, comp_text in enumerate(components):
        try:
            r = _resolve_component(
                comp_text,
                parent_size_modifier=parsed.size_modifier,
                is_first=(i == 0),
            )
            resolved.append(r)
            if r.get("is_estimated", True):
                any_estimated = True
        except Exception:
            failed_count  += 1
            any_estimated  = True

    # ── All-failed fallback ───────────────────────────────────────────────────
    if not resolved:
        result = get_nutrition(original_query)
        return {**result, "_decomposition_meta": {
            "component_count": len(components),
            "resolved_count":  0,
            "failed_count":    len(components),
            "any_estimated":   True,
        }}

    # ── Aggregate macros ──────────────────────────────────────────────────────
    total_calories = sum(r.get("calories", 0) for r in resolved)
    total_protein  = sum(r.get("protein",  0) for r in resolved)
    total_carbs    = sum(r.get("carbs",    0) for r in resolved)
    total_fat      = sum(r.get("fat",      0) for r in resolved)

    # Build a transparent source description from the component USDA matches.
    # Cap at 3 entries so the field stays readable.
    source_parts = [
        r["source_name"] for r in resolved
        if r.get("source_name")
    ]

    return {
        "name":                original_query.strip(),
        "calories":            round(total_calories, 1),
        "protein":             round(total_protein,  1),
        "carbs":               round(total_carbs,    1),
        "fat":                 round(total_fat,      1),
        "is_estimated":        any_estimated,
        "source_type":         "composite_meal",
        "source_name":         "; ".join(source_parts[:3]) if source_parts else "",
        "brand_name":          None,
        # serving_description: useful context when >1 component was resolved
        "serving_description": (
            f"{len(resolved)}-component meal" if len(resolved) > 1 else None
        ),
        "_decomposition_meta": {
            "component_count": len(components),
            "resolved_count":  len(resolved),
            "failed_count":    failed_count,
            "any_estimated":   any_estimated,
        },
    }
