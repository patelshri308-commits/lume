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


SMALL_BENCHMARK = [
    AuditCase("banana", 70, 140),
    AuditCase("white rice", 120, 230),
    AuditCase("100g chicken breast", 120, 220),
    AuditCase("whole milk", 120, 180),
    AuditCase("almonds", 140, 210),
    AuditCase("pasta", 120, 260),
    AuditCase("1 tbsp olive oil", 100, 140),
    AuditCase("2 eggs", 120, 220),
]


def _round(value: Any) -> Any:
    if isinstance(value, float):
        return round(value, 2)
    return value


def _evaluate(case: AuditCase, result: dict[str, Any]) -> tuple[str, str]:
    failures: list[str] = []

    calories = result.get("calories")
    if not isinstance(calories, (int, float)):
        failures.append("missing calories")
    elif not case.min_calories <= float(calories) <= case.max_calories:
        failures.append(f"calories outside {case.min_calories:g}-{case.max_calories:g}")

    if result.get("source_type") != case.expected_source_type:
        failures.append(f"source_type != {case.expected_source_type}")

    if case.require_source_backed and result.get("is_estimated") is True:
        failures.append("estimated result")

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
        passed = sum(row["status"] == "PASS" for row in rows)
        print(f"\nSummary: {passed}/{len(rows)} passed")

    return 1 if any(row["status"] == "FAIL" for row in rows) else 0


if __name__ == "__main__":
    raise SystemExit(main())
