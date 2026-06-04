#!/usr/bin/env python3
"""
Phase 8D Real-World Query Benchmark for the Lume food engine.

Tests 46 realistic user-typed queries across 6 categories.
Goal: diagnosis. Identify where real-world inputs break, classify root causes.

Verdict tiers:
  PASS     — calories in expected range; no critical source concerns.
  WARNING  — calories plausible but something is off (wrong route, per-100g
             returned for a serving query, unexpected estimated fallback).
  FAIL     — calories clearly outside range; or source_name contains a wrong
             food; or zero calories when >0 expected.

Run:
    cd backend && python3 scripts/audit_phase8d.py
    cd backend && python3 scripts/audit_phase8d.py --verbose   # source_name per row
    cd backend && python3 scripts/audit_phase8d.py --json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from dotenv import load_dotenv
load_dotenv(BACKEND_ROOT / ".env")

from app.services.query_router import route_food_query  # noqa: E402


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Phase8DCase:
    """One real-world query benchmark case."""
    query:            str
    category:         str    # see CATEGORY_LABELS
    cal_min:          float  # tight PASS range
    cal_max:          float
    # WARNING band outside [cal_min, cal_max]. Default 0 → auto-compute.
    warn_min:         float = 0.0   # 0 → cal_min * 0.55
    warn_max:         float = 0.0   # 0 → cal_max * 1.65
    # Routing expectation — empty means "don't check"
    expected_source:  str = ""
    # Terms that, if found in source_name, immediately signal a wrong food
    bad_source_terms: tuple[str, ...] = ()
    note:             str = ""


CATEGORY_LABELS: dict[str, str] = {
    "size_ambiguity": "1. Serving-size ambiguity",
    "egg_protein":    "2. Egg and protein variations",
    "sandwich":       "3. Sandwiches and modifiers",
    "restaurant":     "4. Restaurant and branded foods",
    "composite":      "5. Composite foods",
    "quantity":       "6. Quantity and scaling tests",
}


# ---------------------------------------------------------------------------
# Benchmark — 46 realistic queries
# ---------------------------------------------------------------------------

BENCHMARK: list[Phase8DCase] = [

    # ── 1. Serving-size ambiguity ─────────────────────────────────────────────
    # Tests whether size modifiers (large/medium/small) are applied correctly.
    # banana profile has unit_grams for large(136g) and small(101g) but NOT medium.
    Phase8DCase("banana",        "size_ambiguity",  80, 125),
    Phase8DCase("large banana",  "size_ambiguity",  90, 150, note="→ 136g via profile unit_grams"),
    Phase8DCase("medium banana", "size_ambiguity",  80, 128, note="'medium' not in unit_grams → defaults to 118g"),
    Phase8DCase("small banana",  "size_ambiguity",  60, 108, note="→ 101g via profile unit_grams"),
    Phase8DCase("apple",         "size_ambiguity",  75, 148),
    Phase8DCase("large apple",   "size_ambiguity", 108, 185, note="apple profile has unit_grams['large']=223g"),
    Phase8DCase("orange",        "size_ambiguity",  40,  95),

    # ── 2. Egg and protein variations ────────────────────────────────────────
    # Tests verified registry, prep-modifier handling, oz scaling, plural forms.
    Phase8DCase("egg",                   "egg_protein",  55,  95),
    Phase8DCase("eggs",                  "egg_protein",  55,  95, note="same verified entry as 'egg'"),
    Phase8DCase("2 eggs",                "egg_protein", 118, 178),
    Phase8DCase("3 eggs",                "egg_protein", 174, 268),
    Phase8DCase("scrambled eggs",        "egg_protein", 100, 325, note="no 'scrambled eggs' profile; returns per-100g USDA"),
    Phase8DCase("fried eggs",            "egg_protein",  65, 275, note="no 'fried eggs' profile"),
    Phase8DCase("boiled eggs",           "egg_protein",  55, 178, note="no 'boiled eggs' profile; may return 1 or 2 eggs"),
    Phase8DCase("chicken breast",        "egg_protein", 128, 208),
    Phase8DCase("grilled chicken breast","egg_protein", 128, 218, note="'grilled chicken breast' misses profile → per-100g"),
    Phase8DCase("8 oz chicken breast",   "egg_protein", 282, 472, note="8oz=227g; chicken breast profile handles oz"),
    Phase8DCase("2 chicken breasts",     "egg_protein", 245, 525, note="plural 'chicken breasts' may miss profile key"),

    # ── 3. Sandwiches and modifiers ───────────────────────────────────────────
    # 'on wheat'/'on rye' triggers COMPOSITE_MEAL via base_modifier.
    # 'and jelly' triggers COMPOSITE_MEAL via ' and ' in core_food.
    Phase8DCase("turkey sandwich",                "sandwich", 250, 580),
    Phase8DCase("turkey sandwich on wheat",       "sandwich", 250, 580,
                expected_source="composite_meal",
                note="base_modifier='on wheat' → COMPOSITE_MEAL"),
    Phase8DCase("turkey sandwich on rye",         "sandwich", 250, 580,
                expected_source="composite_meal"),
    Phase8DCase("peanut butter sandwich",         "sandwich", 260, 540,
                bad_source_terms=("cookies,", "cookie,"),
                note="USDA may confuse with 'Cookies, peanut butter sandwich'"),
    Phase8DCase("peanut butter and jelly sandwich","sandwich", 308, 658,
                expected_source="composite_meal",
                note="' and ' → COMPOSITE_MEAL; wide range covers estimates"),
    Phase8DCase("grilled cheese sandwich",        "sandwich", 258, 665,
                note="no profile; composite or generic depending on classifier"),

    # ── 4. Restaurant and branded foods ──────────────────────────────────────
    # mcdonalds/chipotle/starbucks → RESTAURANT_ITEM.
    # hershey/oreo → BRANDED_PACKAGED.
    # 'costco hot dog' → NOT a restaurant signal (costco absent); likely GENERIC_FOOD.
    Phase8DCase("mcdonalds cheeseburger",       "restaurant", 255, 448,
                expected_source="restaurant"),
    Phase8DCase("mcdonalds fries",              "restaurant", 188, 418,
                expected_source="restaurant"),
    Phase8DCase("large fries",                  "restaurant", 358, 658,
                note="GENERIC_FOOD with 'large' size modifier (1.35×)"),
    Phase8DCase("chipotle chicken bowl",        "restaurant", 480, 1125,
                expected_source="restaurant"),
    Phase8DCase("starbucks caramel frappuccino","restaurant", 258, 668),
    Phase8DCase("costco hot dog",               "restaurant", 328, 668,
                bad_source_terms=("relish",),
                note="'costco' not in restaurant signals → GENERIC_FOOD; hot dog source risk"),
    Phase8DCase("hershey bar",                  "restaurant", 162, 268,
                expected_source="packaged_product"),
    Phase8DCase("oreo cookies",                 "restaurant", 92, 268,
                expected_source="packaged_product"),

    # ── 5. Composite foods ────────────────────────────────────────────────────
    # Queries with 'with' → COMPOSITE_MEAL; others → GENERIC_FOOD or AMBIGUOUS.
    Phase8DCase("oatmeal with fruit",  "composite", 192, 472,
                expected_source="composite_meal"),
    Phase8DCase("coffee with milk",    "composite",  18, 128,
                expected_source="composite_meal"),
    Phase8DCase("yogurt with granola", "composite", 172, 545,
                expected_source="composite_meal"),
    Phase8DCase("banana smoothie",     "composite", 142, 458,
                note="GENERIC_FOOD; meal-calorie floor rejects raw banana → fallback estimate"),
    Phase8DCase("protein shake",       "composite",  72, 378,
                note="no profile; GENERIC_FOOD or rule-based"),
    Phase8DCase("chicken rice bowl",   "composite", 318, 985,
                note="3-word query → GENERIC_FOOD (not ambiguous); no profile"),
    Phase8DCase("salad with chicken",  "composite", 168, 712,
                expected_source="composite_meal"),

    # ── 6. Quantity and scaling tests ─────────────────────────────────────────
    # Tests plural forms, unit-quantity combos, and count×serving logic.
    # banana/apple plurals miss profile keys (key is singular) → USDA per-100g × n
    Phase8DCase("2 bananas",           "quantity", 142, 272,
                note="plural 'bananas' misses verified+profile; per-100g×2 expected"),
    Phase8DCase("3 bananas",           "quantity", 212, 408,
                note="plural; per-100g×3 if profile missed"),
    Phase8DCase("2 apples",            "quantity", 128, 318,
                note="plural 'apples' misses profile key → per-100g×2"),
    Phase8DCase("2 tbsp peanut butter","quantity", 148, 242,
                note="peanut butter profile has unit_grams['tbsp']=16g → should PASS"),
    Phase8DCase("3 cups rice",         "quantity", 488, 788,
                note="rice profile has unit_grams['cups']=158g; 3×158g=474g"),
    Phase8DCase("2 slices pizza",      "quantity", 338, 768,
                note="no pizza profile; 'slices' unit ignored → USDA per-100g×2"),
    Phase8DCase("2 cheeseburgers",     "quantity", 418, 1625,
                warn_min=200, warn_max=1800,
                note="non-deterministic; range covers 2×(296 to 650)"),
]


# ---------------------------------------------------------------------------
# Root-cause classifier
# ---------------------------------------------------------------------------

_ROOT_CAUSES = (
    "source_selection",
    "serving_size_scaling",
    "quantity_parsing",
    "modifier_handling",
    "branded_food_routing",
    "restaurant_food_routing",
    "composite_interpretation",
    "unknown",
)


def _classify_root_cause(case: Phase8DCase, result: dict) -> str:
    """
    Map a non-PASS result to the most likely root-cause category.
    Returns one of the strings in _ROOT_CAUSES.
    """
    cal         = float(result.get("calories") or 0)
    source_type = result.get("source_type") or ""
    source_name = (result.get("source_name") or "").lower()
    serving     = (result.get("serving_description") or "").lower()
    is_est      = bool(result.get("is_estimated"))
    q           = case.query.lower()

    # 1. Explicitly wrong food in source name
    if case.bad_source_terms and any(t in source_name for t in case.bad_source_terms):
        return "source_selection"

    # 2. Expected routing not taken
    if case.expected_source:
        exp = case.expected_source
        if exp == "restaurant" and "restaurant" not in source_type:
            return "restaurant_food_routing"
        if exp == "packaged_product" and "packaged" not in source_type:
            return "branded_food_routing"
        if exp == "composite_meal" and source_type != "composite_meal":
            return "composite_interpretation"

    # 3. Explicit unit word in query but returned per 100g (unit not converted)
    has_unit_word = bool(
        re.search(r'\btbsp\b|\btsp\b|\boz\b|\bcups?\b|\bslices?\b', q)
        and not re.match(r'^\d+g\b', q)   # exclude "100g ..." style queries
    )
    if has_unit_word and "per 100g" in serving:
        return "serving_size_scaling"

    # 4. Quantity multiplier didn't apply (result ≈ 1× instead of N×)
    qty_match = re.match(r'^([2-9])\s', q)
    if qty_match:
        n = int(qty_match.group(1))
        single_est = (case.cal_min + case.cal_max) / 2 / n
        if cal > 0 and cal < single_est * 1.4:
            return "quantity_parsing"

    # 5. Prep/size modifier in query; result is per-100g (modifier effectively ignored)
    if re.search(r'\b(large|small|medium|grilled|fried|scrambled|boiled)\b', q):
        if "per 100g" in serving:
            return "modifier_handling"

    # 6. Meal-type query returned per-100g without a serving size applied
    if "per 100g" in serving:
        query_words = [w for w in q.split() if len(w) > 3]
        if len(query_words) > 1 and not re.match(r'^\d+g\b', q):
            return "serving_size_scaling"

    # 7. Estimated fallback where USDA source expected
    if is_est and case.category in ("size_ambiguity", "egg_protein", "quantity"):
        return "serving_size_scaling"

    # 8. Source name doesn't mention any key query word (generic wrong-source)
    key_words = [w for w in q.split() if len(w) > 3
                 and w not in ("with", "and", "the", "large", "small", "medium")]
    if key_words and source_name and not any(w in source_name for w in key_words[:2]):
        return "source_selection"

    return "unknown"


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _evaluate_case(case: Phase8DCase, result: dict) -> dict[str, Any]:
    cal         = float(result.get("calories") or 0)
    source_type = result.get("source_type") or ""
    source_name = result.get("source_name") or ""
    serving     = result.get("serving_description") or ""
    is_est      = result.get("is_estimated")
    confidence  = result.get("confidence")

    warn_lo = case.warn_min or case.cal_min * 0.55
    warn_hi = case.warn_max or case.cal_max * 1.65

    wrong_source = bool(
        case.bad_source_terms
        and any(t in source_name.lower() for t in case.bad_source_terms)
    )
    zero_fail = (cal == 0.0 and case.cal_min > 5)
    out_of_warn = (cal < warn_lo or cal > warn_hi)

    if wrong_source or zero_fail or out_of_warn:
        status = "FAIL"
    elif case.cal_min <= cal <= case.cal_max:
        # Calories in PASS range — check soft concerns
        soft = False
        if case.expected_source and case.expected_source not in source_type:
            soft = True
        # per-100g returned for a multi-word serving query
        sn = serving.lower()
        q  = case.query.lower()
        if "per 100g" in sn and len(q.split()) > 1 and not re.match(r'^\d+g\b', q):
            soft = True
        # estimated fallback for whole-food categories
        if is_est and case.category in ("size_ambiguity", "egg_protein", "quantity"):
            soft = True
        status = "WARNING" if soft else "PASS"
    else:
        status = "WARNING"

    root_cause = _classify_root_cause(case, result) if status != "PASS" else ""

    return {
        "status":       status,
        "query":        case.query,
        "category":     case.category,
        "calories":     round(cal, 1),
        "cal_range":    f"{case.cal_min:.0f}-{case.cal_max:.0f}",
        "protein":      round(float(result.get("protein") or 0), 1),
        "carbs":        round(float(result.get("carbs") or 0), 1),
        "fat":          round(float(result.get("fat") or 0), 1),
        "source_type":  source_type,
        "source_name":  source_name,
        "serving":      serving,
        "is_estimated": is_est,
        "confidence":   confidence,
        "root_cause":   root_cause,
        "note":         case.note,
    }


# ---------------------------------------------------------------------------
# Recommendations generator
# ---------------------------------------------------------------------------

def _generate_recommendations(rows: list[dict]) -> list[str]:
    issues = [r for r in rows if r["status"] != "PASS"]
    cause_counts: Counter[str] = Counter(r["root_cause"] for r in issues if r["root_cause"])

    recs: list[str] = []
    if cause_counts.get("serving_size_scaling", 0) >= 2:
        recs.append(
            "serving_size_scaling (%d cases): Add GenericFoodProfile entries for foods "
            "with missing profiles (e.g. butter, sugar, steak, grilled/scrambled/fried/boiled "
            "egg variants). Each needs default_grams and unit_grams so tbsp/tsp/oz queries "
            "convert to grams instead of returning per-100g data." % cause_counts["serving_size_scaling"]
        )
    if cause_counts.get("quantity_parsing", 0) >= 2:
        recs.append(
            "quantity_parsing (%d cases): Add plural-form aliases in verified_foods.py and "
            "_GENERIC_FOOD_PROFILES so 'bananas' → banana profile, 'apples' → apple profile. "
            "Without profile lookup the engine multiplies per-100g × count instead of "
            "profile.default_grams × count." % cause_counts["quantity_parsing"]
        )
    if cause_counts.get("source_selection", 0) >= 2:
        recs.append(
            "source_selection (%d cases): Improve USDA query terms and avoid_terms for "
            "ambiguous multi-word foods (hot dog → avoid 'relish'; peanut butter sandwich → "
            "avoid 'cookie'; cheese pizza slice → add pizza profile). Consider adding "
            "dedicated profiles for common meal foods." % cause_counts["source_selection"]
        )
    if cause_counts.get("modifier_handling", 0) >= 2:
        recs.append(
            "modifier_handling (%d cases): Preparation modifiers ('scrambled', 'fried', "
            "'boiled', 'grilled') are not mapped to specific USDA search terms. Add profile "
            "entries or search-query overrides for common prep-modified foods (scrambled eggs, "
            "grilled chicken breast)." % cause_counts["modifier_handling"]
        )
    if cause_counts.get("restaurant_food_routing", 0) >= 2:
        recs.append(
            "restaurant_food_routing (%d cases): Some restaurant queries are not reaching "
            "the restaurant service. Check that all chain names are in _RESTAURANT_SIGNALS "
            "and that OFF restaurant search covers the items." % cause_counts["restaurant_food_routing"]
        )
    if cause_counts.get("branded_food_routing", 0) >= 2:
        recs.append(
            "branded_food_routing (%d cases): Some branded queries are falling through to "
            "USDA instead of Open Food Facts. Review _PACKAGED_SIGNALS coverage." % cause_counts["branded_food_routing"]
        )
    if cause_counts.get("composite_interpretation", 0) >= 2:
        recs.append(
            "composite_interpretation (%d cases): Some 'with' queries are not routing to "
            "the composite service, or composite decomposition is producing unreliable results. "
            "Review the composite service component resolution." % cause_counts["composite_interpretation"]
        )
    if not recs:
        recs.append("No dominant failure pattern — investigate individual failures case-by-case.")
    return recs


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

_PASS = "PASS"
_WARN = "WARNING"
_FAIL = "FAIL"
_SYM  = {_PASS: "✓", _WARN: "⚠", _FAIL: "✗"}


def print_report(rows: list[dict], verbose: bool = False) -> None:
    from datetime import date
    W = 108
    print(f"\nPhase 8D Real-World Query Benchmark  —  {date.today().isoformat()}")
    print("=" * W)

    categories = list(dict.fromkeys(r["category"] for r in rows))
    by_cat: dict[str, list[dict]] = {c: [] for c in categories}
    for r in rows:
        by_cat[r["category"]].append(r)

    for cat in categories:
        cat_rows = by_cat[cat]
        n_pass   = sum(1 for r in cat_rows if r["status"] == _PASS)
        n_warn   = sum(1 for r in cat_rows if r["status"] == _WARN)
        n_fail   = sum(1 for r in cat_rows if r["status"] == _FAIL)
        label    = CATEGORY_LABELS.get(cat, cat)
        print(f"\n{label}  ({n_pass}✓ {n_warn}⚠ {n_fail}✗ / {len(cat_rows)})")
        print("-" * W)
        print(
            f"  {'St':<4} {'Query':<30} {'Cal':>7}  {'Range':<11}"
            f"  {'Source type':<22}  {'Serving':<22}  Root cause"
        )
        print(
            f"  {'--':<4} {'-----':<30} {'---':>7}  {'-----':<11}"
            f"  {'------------':<22}  {'-------':<22}  ----------"
        )
        for row in cat_rows:
            sym  = _SYM[row["status"]]
            src  = (row["source_type"] or "")[:22]
            srv  = (row["serving"] or "")[:22]
            rc   = row["root_cause"] or ""
            print(
                f"  {sym:<4} {row['query']:<30} {row['calories']:>7.1f}"
                f"  {row['cal_range']:<11}  {src:<22}  {srv:<22}  {rc}"
            )
            if verbose and row["source_name"]:
                print(f"       └─ {row['source_name'][:88]}")

    # Non-PASS details
    non_pass = [r for r in rows if r["status"] != _PASS]
    if non_pass:
        print(f"\n{'=' * W}")
        print("WARNINGS AND FAILURES")
        print("-" * W)
        for row in non_pass:
            sym = _SYM[row["status"]]
            print(f"\n  {sym} {row['query']!r}  [{row['category']}]  root_cause={row['root_cause']!r}")
            print(f"      cal={row['calories']}  range={row['cal_range']}  "
                  f"protein={row['protein']}  carbs={row['carbs']}  fat={row['fat']}")
            print(f"      source_type={row['source_type']!r}  "
                  f"serving={row['serving']!r}  is_estimated={row['is_estimated']}")
            if row["source_name"]:
                print(f"      source_name={row['source_name']!r}")
            if row["note"]:
                print(f"      note: {row['note']}")

    # Analysis section
    total       = len(rows)
    n_pass_all  = sum(1 for r in rows if r["status"] == _PASS)
    n_warn_all  = sum(1 for r in rows if r["status"] == _WARN)
    n_fail_all  = sum(1 for r in rows if r["status"] == _FAIL)

    print(f"\n{'=' * W}")
    print("ANALYSIS")
    print("-" * W)

    # 1. Overall pass rate
    pct = 100 * n_pass_all // total
    print(f"\n  1. Overall:  {n_pass_all}/{total} PASS ({pct}%)  |  {n_warn_all} WARNING  |  {n_fail_all} FAIL")

    # 2. Per-category pass rate
    print("\n  2. By category:")
    for cat in categories:
        cat_rows = by_cat[cat]
        np = sum(1 for r in cat_rows if r["status"] == _PASS)
        nw = sum(1 for r in cat_rows if r["status"] == _WARN)
        nf = sum(1 for r in cat_rows if r["status"] == _FAIL)
        pct = 100 * np // len(cat_rows)
        label = CATEGORY_LABELS.get(cat, cat)
        print(f"     {label:<40}  {np}/{len(cat_rows)} ({pct:3d}%)  "
              f"{nw}⚠  {nf}✗")

    # 3. Top recurring failure categories
    cause_counts: Counter[str] = Counter(
        r["root_cause"] for r in rows if r["status"] != _PASS and r["root_cause"]
    )
    if cause_counts:
        print("\n  3. Root-cause frequency (WARNING + FAIL only):")
        for cause, cnt in cause_counts.most_common():
            print(f"     {cnt:>3}×  {cause}")

    # 4. Top problematic foods
    problem = [r for r in rows if r["status"] == _FAIL]
    if problem:
        print("\n  4. Queries most likely to mislead users (FAIL only):")
        for r in problem:
            print(f"     • {r['query']!r}  —  {r['root_cause']} "
                  f"(returned {r['calories']} kcal, expected {r['cal_range']})")
    else:
        warn_rows = [r for r in rows if r["status"] == _WARN]
        if warn_rows:
            print("\n  4. Queries returning WARNING-level results:")
            for r in warn_rows[:8]:
                print(f"     • {r['query']!r}  —  {r['root_cause']}")

    # 5. Recommendations
    recs = _generate_recommendations(rows)
    print("\n  5. Recommendations for the next phase:")
    for i, rec in enumerate(recs, 1):
        # Wrap at ~90 chars
        wrapped = []
        line = f"     {i}. "
        for word in rec.split():
            if len(line) + len(word) + 1 > 100:
                wrapped.append(line)
                line = "        " + word + " "
            else:
                line += word + " "
        wrapped.append(line)
        print("\n".join(wrapped))

    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Phase 8D real-world query benchmark for the Lume food engine."
    )
    parser.add_argument("--json",    action="store_true",
                        help="Emit machine-readable JSON.")
    parser.add_argument("--verbose", action="store_true",
                        help="Show source_name for every row in the table.")
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for case in BENCHMARK:
        try:
            result = route_food_query(case.query)
        except Exception as exc:
            rows.append({
                "status":       "FAIL",
                "query":        case.query,
                "category":     case.category,
                "calories":     None,
                "cal_range":    f"{case.cal_min:.0f}-{case.cal_max:.0f}",
                "protein":      None,
                "carbs":        None,
                "fat":          None,
                "source_type":  "error",
                "source_name":  "",
                "serving":      "",
                "is_estimated": None,
                "confidence":   None,
                "root_cause":   "unknown",
                "note":         f"{type(exc).__name__}: {exc}",
            })
            continue
        rows.append(_evaluate_case(case, result))

    if args.json:
        print(json.dumps(rows, indent=2, default=str))
    else:
        print_report(rows, verbose=args.verbose)

    return 1 if any(r["status"] == _FAIL for r in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
