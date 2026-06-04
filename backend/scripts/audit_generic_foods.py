#!/usr/bin/env python3
"""
Small local audit for Lume's generic food benchmark.

This is intentionally diagnostic only: it does not change food-engine behavior,
database state, production config, or deployment settings. It calls the backend
router directly and may perform live USDA lookups through the existing service
code, so use it when you explicitly want a quick local spot check.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

load_dotenv(BACKEND_ROOT / ".env")

from app.services.query_router import route_food_query  # noqa: E402


@dataclass(frozen=True)
class AuditCase:
    query: str
    min_calories: float
    max_calories: float
    require_source_backed: bool = True
    expected_source_type: str = "generic"
    # Source-name quality checks (case-insensitive substring match).
    # Fail if source_name lacks any required term.
    required_source_terms: tuple[str, ...] = ()
    # Fail if source_name contains any disallowed term.
    disallowed_source_terms: tuple[str, ...] = ()
    # Fail if serving_description lacks any required term.
    required_serving_terms: tuple[str, ...] = ()


# ── Source-quality benchmark ──────────────────────────────────────────────────
# Checks correct USDA source selection for 8 common whole foods.
# All 8 should pass after Phase 2 + Phase 3 fixes.
SOURCE_QUALITY_BENCHMARK: list[AuditCase] = [
    AuditCase("banana", 70, 140),
    AuditCase(
        "white rice", 120, 230,
        disallowed_source_terms=("glutinous",),
    ),
    AuditCase(
        "100g chicken breast", 120, 220,
        required_serving_terms=("100",),
    ),
    AuditCase(
        "whole milk", 120, 180,
        disallowed_source_terms=("buttermilk", "cheese", "evaporated"),
    ),
    AuditCase(
        "almonds", 140, 210,
        disallowed_source_terms=("paste", "milk", "butter", "flour"),
    ),
    AuditCase(
        "pasta", 120, 260,
        disallowed_source_terms=("gluten-free", "corn"),
    ),
    AuditCase(
        "1 tbsp olive oil", 100, 140,
        required_serving_terms=("tbsp",),
        disallowed_source_terms=("corn", "peanut", "canola", "vegetable", "soybean", "sunflower"),
    ),
    AuditCase(
        "2 eggs", 120, 220,
        disallowed_source_terms=("fried", "egg white", "substitute"),
    ),
]

# ── Quantity-scaling benchmark ────────────────────────────────────────────────
# Checks that unit/size parsing and gram scaling work end-to-end.
# Serving descriptions are verified to confirm the right path was taken.
QUANTITY_BENCHMARK: list[AuditCase] = [
    # Cup-based scaling: 1 cup == 158 g cooked rice
    AuditCase(
        "1 cup white rice", 150, 270,
        required_serving_terms=("cup",),
        disallowed_source_terms=("glutinous",),
    ),
    # Fractional cup: 2.5 × 158 g = 395 g
    AuditCase(
        "2.5 cups white rice", 380, 680,
        required_serving_terms=("cups",),
        disallowed_source_terms=("glutinous",),
    ),
    # Tablespoon: 2 × 16 g = 32 g peanut butter
    AuditCase(
        "2 tbsp peanut butter", 160, 230,
        required_serving_terms=("tbsp",),
    ),
    # Size-modifier path: "large" maps to 136 g in the banana profile
    AuditCase(
        "1 large banana", 90, 165,
        required_serving_terms=("large",),
    ),
    # Size-modifier path: "small" maps to 149 g in the apple profile
    AuditCase(
        "1 small apple", 50, 120,
        required_serving_terms=("small",),
    ),
]

# ── Coverage benchmark ────────────────────────────────────────────────────────
# Broader generic whole-food coverage added in Phase 6.
# Disallowed terms mirror the profiles' avoid_terms so audit catches wrong-form
# regressions that the engine scoring might otherwise miss.
COVERAGE_BENCHMARK: list[AuditCase] = [
    # Fruits
    AuditCase(
        "apple", 60, 150,
        disallowed_source_terms=("juice", "sauce", "dried"),
    ),
    AuditCase(
        "orange", 40, 100,
        disallowed_source_terms=("juice", "drink"),
    ),
    AuditCase(
        "strawberries", 30, 90,
        disallowed_source_terms=("syrup", "jam"),
    ),
    AuditCase(
        "blueberries", 50, 130,
        disallowed_source_terms=("dried", "jam"),
    ),
    AuditCase(
        "avocado", 150, 360,
        disallowed_source_terms=("oil", "guacamole"),
    ),
    # Vegetables
    AuditCase(
        "broccoli", 30, 100,
        disallowed_source_terms=("soup", "casserole"),
    ),
    AuditCase(
        "spinach", 4, 40,
        disallowed_source_terms=("dip", "souffle"),
    ),
    AuditCase(
        "potato", 100, 250,
        disallowed_source_terms=("chips", "fries", "flour"),
    ),
    AuditCase(
        "sweet potato", 70, 180,
        disallowed_source_terms=("chips", "fries", "flour"),
    ),
    # Grains
    AuditCase(
        "brown rice", 150, 310,
        disallowed_source_terms=("flour", "dry"),
    ),
    AuditCase(
        "oatmeal", 100, 270,
        disallowed_source_terms=("cookie", "bar", "dry"),
    ),
    # Proteins
    AuditCase(
        "salmon", 140, 280,
        disallowed_source_terms=("oil", "smoked", "canned"),
    ),
    AuditCase(
        "ground beef", 150, 320,
        disallowed_source_terms=("raw",),
    ),
    # Dairy
    AuditCase(
        "greek yogurt", 50, 200,
        disallowed_source_terms=("flavored", "sweetened", "frozen"),
    ),
    AuditCase(
        "cheddar cheese", 80, 160,
        disallowed_source_terms=("sauce", "spread", "powder"),
    ),
    # Legumes
    AuditCase(
        "black beans", 150, 320,
        disallowed_source_terms=("dry", "dried", "flour"),
    ),
]

SMALL_BENCHMARK: list[AuditCase] = (
    SOURCE_QUALITY_BENCHMARK + QUANTITY_BENCHMARK + COVERAGE_BENCHMARK
)


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 2)
    return value


def _evaluate(case: AuditCase, result: dict[str, Any]) -> tuple[str, str]:
    failures: list[str] = []

    # ── Existing checks ───────────────────────────────────────────────────────

    calories = result.get("calories")
    if not isinstance(calories, (int, float)):
        failures.append("missing calories")
    elif not case.min_calories <= float(calories) <= case.max_calories:
        failures.append(f"calories outside {case.min_calories:g}-{case.max_calories:g}")

    actual_source_type = result.get("source_type")
    # "verified_generic" is a subtype of "generic" — accept both when "generic" is expected.
    generic_family = {"generic", "verified_generic"}
    source_type_ok = (
        actual_source_type == case.expected_source_type
        or (case.expected_source_type == "generic" and actual_source_type in generic_family)
    )
    if not source_type_ok:
        failures.append(f"source_type != {case.expected_source_type}")

    if case.require_source_backed and result.get("is_estimated") is True:
        failures.append("estimated result")

    # ── Source-name quality checks ────────────────────────────────────────────

    source_name = (result.get("source_name") or "").lower()

    for term in case.required_source_terms:
        if term.lower() not in source_name:
            failures.append(f"source missing '{term}'")

    for term in case.disallowed_source_terms:
        if term.lower() in source_name:
            failures.append(f"source contains disallowed '{term}'")

    # ── Serving-description quality checks ────────────────────────────────────

    serving = (result.get("serving_description") or "").lower()

    for term in case.required_serving_terms:
        if term.lower() not in serving:
            failures.append(f"serving missing '{term}'")

    return ("FAIL", "; ".join(failures)) if failures else ("PASS", "")


def audit_case(case: AuditCase) -> dict[str, Any]:
    try:
        result = route_food_query(case.query)
    except Exception as exc:  # pragma: no cover - diagnostic script
        return {
            "status": "FAIL",
            "query": case.query,
            "reason": f"{type(exc).__name__}: {exc}",
        }

    status, reason = _evaluate(case, result)
    return {
        "status": status,
        "query": case.query,
        "calories": _round(result.get("calories")),
        "protein": _round(result.get("protein")),
        "carbs": _round(result.get("carbs")),
        "fat": _round(result.get("fat")),
        "source_type": result.get("source_type"),
        "confidence": _round(result.get("confidence")),
        "is_estimated": result.get("is_estimated"),
        "serving_description": result.get("serving_description"),
        "source_name": result.get("source_name"),
        "reason": reason,
    }


def print_table(rows: list[dict[str, Any]]) -> None:
    headers = [
        "status",
        "query",
        "calories",
        "source_type",
        "confidence",
        "is_estimated",
        "serving_description",
        "source_name",
        "reason",
    ]
    widths = {
        header: max(len(header), *(len(str(row.get(header, ""))) for row in rows))
        for header in headers
    }
    print(" | ".join(header.ljust(widths[header]) for header in headers))
    print("-+-".join("-" * widths[header] for header in headers))
    for row in rows:
        print(" | ".join(str(row.get(header, "")).ljust(widths[header]) for header in headers))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a small Lume generic-food audit.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    args = parser.parse_args()

    rows = [audit_case(case) for case in SMALL_BENCHMARK]
    if args.json:
        print(json.dumps(rows, indent=2))
    else:
        print_table(rows)
        sq_total  = len(SOURCE_QUALITY_BENCHMARK)
        qty_total = len(QUANTITY_BENCHMARK)
        cov_total = len(COVERAGE_BENCHMARK)
        sq_end    = sq_total
        qty_end   = sq_total + qty_total
        sq_pass   = sum(row["status"] == "PASS" for row in rows[:sq_end])
        qty_pass  = sum(row["status"] == "PASS" for row in rows[sq_end:qty_end])
        cov_pass  = sum(row["status"] == "PASS" for row in rows[qty_end:])
        total     = sq_total + qty_total + cov_total
        passed    = sq_pass + qty_pass + cov_pass
        print(f"\nSource-quality:  {sq_pass}/{sq_total} passed")
        print(f"Quantity-scaling: {qty_pass}/{qty_total} passed")
        print(f"Coverage:        {cov_pass}/{cov_total} passed")
        print(f"Total:           {passed}/{total} passed")

    return 1 if any(row["status"] == "FAIL" for row in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
