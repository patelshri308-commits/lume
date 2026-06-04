#!/usr/bin/env python3
"""
Phase 8C broader benchmark audit for the Lume food engine.

Tests 25 common food queries across 5 categories. Goal: diagnosis, not all-pass.
Tells us which foods are accurate, which fail, and why (wrong source, bad scaling,
unit parsing gap, poor fallback, packaged/restaurant ambiguity).

Run:
    cd backend && python3 scripts/audit_phase8c.py
    cd backend && python3 scripts/audit_phase8c.py --verbose   # also shows source_name
    cd backend && python3 scripts/audit_phase8c.py --json
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
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
class Phase8CCase:
    """Single benchmark case with per-macro tolerance ranges."""
    query:       str
    category:    str    # "piece" | "cup" | "tbsp_tsp" | "gram_oz" | "mixed"
    cal_min:     float
    cal_max:     float
    protein_min: float
    protein_max: float
    carbs_min:   float
    carbs_max:   float
    fat_min:     float
    fat_max:     float
    note:        str = ""   # expected caveats or known gaps


# ---------------------------------------------------------------------------
# Benchmark — 25 foods across 5 categories
# ---------------------------------------------------------------------------

BENCHMARK: list[Phase8CCase] = [

    # ── 1. Piece-based foods ─────────────────────────────────────────────────
    # Each query is a plain item name; the engine applies its default serving.
    Phase8CCase("banana",  "piece",  80, 125,  0.8,  1.8,  18, 30,  0.0,  0.8),
    Phase8CCase("apple",   "piece",  70, 140,  0.0,  1.5,  18, 32,  0.0,  0.8),
    Phase8CCase("egg",     "piece",  60,  90,  5.0,  8.5,   0,  2,  4.0,  7.5),
    Phase8CCase("2 eggs",  "piece", 120, 175, 10.0, 17.0,   0,  3,  8.0, 14.0),
    Phase8CCase("orange",  "piece",  40,  90,  0.5,  2.5,  10, 20,  0.0,  0.8),

    # ── 2. Cup-based foods ───────────────────────────────────────────────────
    # Each query includes an explicit "1 cup" prefix so the unit path is exercised.
    Phase8CCase("1 cup white rice",   "cup", 175, 250,  3.0,  6.5,  38, 54,  0.0,  1.5),
    Phase8CCase("1 cup brown rice",   "cup", 190, 290,  3.0,  7.5,  40, 58,  1.0,  4.5),
    Phase8CCase("1 cup oatmeal",      "cup", 130, 240,  4.0,  9.0,  20, 40,  1.5,  6.0),
    Phase8CCase("1 cup whole milk",   "cup", 120, 182,  7.0, 11.0,   9, 16,  5.5, 11.0),
    Phase8CCase("1 cup greek yogurt", "cup", 100, 275, 12.0, 36.0,   4, 26,  0.0, 12.0),

    # ── 3. Tablespoon / teaspoon foods ───────────────────────────────────────
    # olive oil & peanut butter have profiles; butter & sugar do not.
    Phase8CCase("1 tbsp olive oil",     "tbsp_tsp", 110, 132,  0.0, 0.5,  0.0, 0.5, 12.0, 15.5,
                note="verified entry — expected PASS"),
    Phase8CCase("1 tbsp peanut butter", "tbsp_tsp",  80, 118,  3.0, 5.5,  2.0, 5.5,  7.0, 10.5),
    Phase8CCase("1 tbsp butter",        "tbsp_tsp",  85, 128,  0.0, 0.5,  0.0, 0.5,  9.5, 13.5,
                note="no profile — tbsp→g conversion absent; expects FAIL"),
    Phase8CCase("1 tsp sugar",          "tbsp_tsp",  10,  25,  0.0, 0.2,  4.0, 6.0,  0.0, 0.2,
                note="no profile — tsp→g conversion absent; expects FAIL"),

    # ── 4. Gram / ounce protein foods ────────────────────────────────────────
    # 100g queries exercise the compact-qty path; 4 oz exercises _grams_from_unit.
    # steak has no profile so 4 oz scaling is expected to fail.
    Phase8CCase("100g chicken breast", "gram_oz", 140, 198, 25.0, 35.0,  0.0, 3.0,  2.0,  7.0,
                note="verified entry"),
    Phase8CCase("100g salmon",         "gram_oz", 155, 260, 17.0, 29.0,  0.0, 3.0,  7.0, 19.0),
    Phase8CCase("100g ground beef",    "gram_oz", 190, 290, 17.0, 29.0,  0.0, 3.0, 11.0, 23.0),
    Phase8CCase("4 oz chicken breast", "gram_oz", 150, 228, 26.0, 42.0,  0.0, 3.0,  2.0,  9.0),
    Phase8CCase("4 oz steak",          "gram_oz", 195, 350, 22.0, 38.0,  0.0, 3.0, 11.0, 27.0,
                note="no profile for steak — oz multiplied as count; expects FAIL"),

    # ── 5. Common mixed / simple foods ───────────────────────────────────────
    # These are expected to rely on rule-based fallback or composite routing.
    # Ranges are intentionally wide; they test whether the engine produces
    # plausible results, not USDA-level precision.
    Phase8CCase("peanut butter sandwich", "mixed", 290, 520, 10.0, 22.0, 26, 60, 10.0, 28.0),
    Phase8CCase("turkey sandwich",        "mixed", 240, 530, 14.0, 34.0, 23, 60,  4.0, 24.0),
    Phase8CCase("cheese pizza slice",     "mixed", 185, 365,  6.0, 19.0, 21, 46,  6.0, 20.0),
    Phase8CCase("cheeseburger",           "mixed", 370, 730, 16.0, 40.0, 28, 68, 16.0, 44.0),
    Phase8CCase("hot dog",                "mixed", 135, 390,  4.0, 17.0, 11, 44,  6.0, 32.0),
    Phase8CCase("chocolate donut",        "mixed", 185, 430,  2.0,  9.0, 24, 58,  6.0, 26.0),
]

CATEGORY_LABELS: dict[str, str] = {
    "piece":    "1. Piece-based foods",
    "cup":      "2. Cup-based foods",
    "tbsp_tsp": "3. Tablespoon / Teaspoon foods",
    "gram_oz":  "4. Gram / Ounce protein foods",
    "mixed":    "5. Common mixed / simple foods",
}


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def _diagnose(case: Phase8CCase, result: dict) -> list[str]:
    """Return a list of diagnostic flags describing likely failure causes."""
    hints: list[str] = []
    actual_cal  = float(result.get("calories") or 0)
    serving     = (result.get("serving_description") or "").lower()
    source_type = (result.get("source_type") or "")

    if result.get("is_estimated"):
        hints.append("rule-based-fallback")

    if source_type in ("packaged_guess", "restaurant_guess"):
        hints.append(f"service-miss-fallback ({source_type})")
    elif source_type == "ambiguous_estimate":
        hints.append("ambiguous-routing")

    # Unit scaling check: detect when a unit word in the query did not
    # reach the serving description, which signals a missing profile.
    query_lower = case.query.lower()
    expected_unit: str | None = None
    if "tbsp" in query_lower:
        expected_unit = "tbsp"
    elif "tsp" in query_lower:
        expected_unit = "tsp"
    elif " oz" in query_lower:
        expected_unit = "oz"
    elif query_lower.startswith("100g") or " g " in query_lower:
        expected_unit = "g"
    elif "cup" in query_lower:
        expected_unit = "cup"

    if expected_unit and expected_unit not in serving:
        hints.append(
            f"unit-not-scaled (expected '{expected_unit}' in serving='{serving or 'none'}')"
        )

    # Magnitude check: if calories are >4× or <0.25× the midpoint of the
    # expected range, something is badly wrong (wrong serving size or wrong food).
    mid = (case.cal_min + case.cal_max) / 2
    if actual_cal > 0 and mid > 0:
        ratio = actual_cal / mid
        if ratio > 4.0:
            hints.append(
                f"calories-way-too-high ({actual_cal:.0f} returned vs ~{mid:.0f} expected)"
            )
        elif ratio < 0.25:
            hints.append(
                f"calories-way-too-low ({actual_cal:.0f} returned vs ~{mid:.0f} expected)"
            )

    return hints


def _evaluate_case(case: Phase8CCase, result: dict) -> dict[str, Any]:
    """Evaluate one result against a Phase8CCase benchmark."""
    actual_cal  = float(result.get("calories") or 0)
    actual_pro  = float(result.get("protein")  or 0)
    actual_carb = float(result.get("carbs")    or 0)
    actual_fat  = float(result.get("fat")      or 0)

    cal_ok  = case.cal_min     <= actual_cal  <= case.cal_max
    pro_ok  = case.protein_min <= actual_pro  <= case.protein_max
    carb_ok = case.carbs_min   <= actual_carb <= case.carbs_max
    fat_ok  = case.fat_min     <= actual_fat  <= case.fat_max
    passed  = cal_ok and pro_ok and carb_ok and fat_ok

    failed_macros: list[str] = []
    if not cal_ok:
        failed_macros.append(
            f"cal={actual_cal:.1f} not in [{case.cal_min:.0f}–{case.cal_max:.0f}]"
        )
    if not pro_ok:
        failed_macros.append(
            f"protein={actual_pro:.1f} not in [{case.protein_min:.0f}–{case.protein_max:.0f}]"
        )
    if not carb_ok:
        failed_macros.append(
            f"carbs={actual_carb:.1f} not in [{case.carbs_min:.0f}–{case.carbs_max:.0f}]"
        )
    if not fat_ok:
        failed_macros.append(
            f"fat={actual_fat:.1f} not in [{case.fat_min:.0f}–{case.fat_max:.0f}]"
        )

    return {
        "status":        "PASS" if passed else "FAIL",
        "query":         case.query,
        "category":      case.category,
        "calories":      round(actual_cal, 1),
        "cal_range":     f"{case.cal_min:.0f}-{case.cal_max:.0f}",
        "protein":       round(actual_pro, 1),
        "pro_range":     f"{case.protein_min:.0f}-{case.protein_max:.0f}",
        "carbs":         round(actual_carb, 1),
        "carbs_range":   f"{case.carbs_min:.0f}-{case.carbs_max:.0f}",
        "fat":           round(actual_fat, 1),
        "fat_range":     f"{case.fat_min:.0f}-{case.fat_max:.0f}",
        "cal_ok":        cal_ok,
        "pro_ok":        pro_ok,
        "carb_ok":       carb_ok,
        "fat_ok":        fat_ok,
        "source_type":   result.get("source_type") or "",
        "source_name":   result.get("source_name") or "",
        "serving":       result.get("serving_description") or "",
        "is_estimated":  result.get("is_estimated"),
        "confidence":    result.get("confidence"),
        "failed_macros": failed_macros,
        "diagnosis":     _diagnose(case, result),
        "note":          case.note,
    }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

_T = "✓"   # pass symbol
_F = "✗"   # fail symbol


def _flag(ok: bool) -> str:
    return _T if ok else _F


def print_report(rows: list[dict[str, Any]], verbose: bool = False) -> None:
    from datetime import date
    today = date.today().isoformat()

    W = 100
    print(f"\nPhase 8C Benchmark Audit  —  {today}")
    print("=" * W)

    # Group rows by category (preserve insertion order)
    categories: list[str] = list(dict.fromkeys(r["category"] for r in rows))
    by_cat: dict[str, list[dict]] = {c: [] for c in categories}
    for row in rows:
        by_cat[row["category"]].append(row)

    for cat in categories:
        cat_rows = by_cat[cat]
        n_pass   = sum(1 for r in cat_rows if r["status"] == "PASS")
        label    = CATEGORY_LABELS.get(cat, cat)
        print(f"\n{label}  ({n_pass}/{len(cat_rows)} passed)")
        print("-" * W)
        print(
            f"  {'St':<4} {'Query':<27} {'Cal':>7}  {'Range':<11}"
            f"  {'Pro':>5} {'Carb':>5} {'Fat':>5}  {'Source type':<20}  Serving"
        )
        print(
            f"  {'--':<4} {'-----':<27} {'---':>7}  {'---------':<11}"
            f"  {'---':>5} {'----':>5} {'---':>5}  {'------------':<20}  -------"
        )
        for row in cat_rows:
            pf     = _flag(row["status"] == "PASS")
            pro_f  = _flag(row["pro_ok"])
            carb_f = _flag(row["carb_ok"])
            fat_f  = _flag(row["fat_ok"])
            src    = (row["source_type"] or "")[:20]
            serving = (row["serving"] or "")[:22]
            # Colour-code calories: show ✓ or ✗ next to the value
            cal_f  = _flag(row["cal_ok"])
            print(
                f"  {pf:<4} {row['query']:<27} {row['calories']:>7.1f}"
                f"  {row['cal_range']:<11}  {pro_f:>5} {carb_f:>5} {fat_f:>5}"
                f"  {src:<20}  {serving}"
            )
            if verbose and row["source_name"]:
                print(f"       └─ {row['source_name'][:80]}")

    # Failure details
    failures = [r for r in rows if r["status"] == "FAIL"]
    if failures:
        print(f"\n{'=' * W}")
        print("FAILURE DETAILS")
        print("-" * W)
        for row in failures:
            print(f"\n  {_F} {row['query']!r}  [{row['category']}]")
            for msg in row["failed_macros"]:
                print(f"      macro : {msg}")
            if row["diagnosis"]:
                print(f"      diag  : {'; '.join(row['diagnosis'])}")
            if row["note"]:
                print(f"      note  : {row['note']}")
            print(
                f"      source: type={row['source_type']!r}  "
                f"serving={row['serving']!r}  "
                f"is_estimated={row['is_estimated']}"
            )
            if row["source_name"]:
                print(f"              name={row['source_name']!r}")
    else:
        print(f"\n{'=' * W}")
        print("No failures.")

    # Per-category + grand total
    print(f"\n{'=' * W}")
    print("SUMMARY")
    print("-" * W)
    grand_pass  = 0
    grand_total = 0
    for cat in categories:
        cat_rows    = by_cat[cat]
        n_pass      = sum(1 for r in cat_rows if r["status"] == "PASS")
        n_total     = len(cat_rows)
        grand_pass  += n_pass
        grand_total += n_total
        pct         = 100 * n_pass // n_total
        label       = CATEGORY_LABELS.get(cat, cat)
        fail_names  = [r["query"] for r in cat_rows if r["status"] == "FAIL"]
        fail_str    = f"  failing: {', '.join(fail_names)}" if fail_names else ""
        print(f"  {label:<38}  {n_pass}/{n_total} ({pct:3d}%){fail_str}")

    pct = 100 * grand_pass // grand_total
    print("-" * W)
    print(f"  TOTAL                                    {grand_pass}/{grand_total} ({pct:3d}%)")
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Phase 8C broader benchmark audit for the Lume food engine."
    )
    parser.add_argument(
        "--json",    action="store_true",
        help="Emit machine-readable JSON instead of a human-readable table.",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Show USDA/verified source_name for every food.",
    )
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for case in BENCHMARK:
        try:
            result = route_food_query(case.query)
        except Exception as exc:
            rows.append({
                "status":        "FAIL",
                "query":         case.query,
                "category":      case.category,
                "calories":      None,
                "cal_range":     f"{case.cal_min:.0f}-{case.cal_max:.0f}",
                "protein":       None,
                "carbs":         None,
                "fat":           None,
                "cal_ok":        False,
                "pro_ok":        False,
                "carb_ok":       False,
                "fat_ok":        False,
                "source_type":   "error",
                "source_name":   "",
                "serving":       "",
                "is_estimated":  None,
                "confidence":    None,
                "failed_macros": [f"exception: {type(exc).__name__}: {exc}"],
                "diagnosis":     ["exception"],
                "note":          case.note,
            })
            continue
        rows.append(_evaluate_case(case, result))

    if args.json:
        print(json.dumps(rows, indent=2, default=str))
    else:
        print_report(rows, verbose=args.verbose)

    return 1 if any(r["status"] == "FAIL" for r in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
