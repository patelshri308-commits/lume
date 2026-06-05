"""
POST /food/parse-multi — unit tests.

All tests mock route_food_query so no network calls are made.
The endpoint lives in routers/food.py and has no auth requirement.

Run:
    cd backend && pytest tests/test_parse_multi.py -v
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.food import MAX_MULTI_LINES

client = TestClient(app)

URL = "/food/parse-multi"

# Canonical nutrition result returned by the mock for every successful line.
_GOOD_RESULT = {
    "name":                "banana",
    "calories":            89.0,
    "protein":             1.1,
    "carbs":               23.0,
    "fat":                 0.3,
    "source_type":         "generic",
    "confidence":          0.85,
    "is_estimated":        False,
    "serving_description": "1 medium (118 g)",
}


def _post(lines: list[str]):
    return client.post(URL, json={"lines": lines})


# ── Happy path ────────────────────────────────────────────────────────────────

def test_single_line_returns_one_item():
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT) as mock:
        res = _post(["banana"])
    assert res.status_code == 200
    body = res.json()
    assert body["skipped"] == 0
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["original_line"]  == "banana"
    assert item["name"]           == "banana"
    assert item["calories"]       == 89.0
    assert item["parse_error"]    is False
    assert item["error_message"]  is None
    assert item["source_type"]    == "generic"
    assert item["confidence"]     == pytest.approx(0.85)
    assert item["is_estimated"]   is False
    assert item["serving_description"] == "1 medium (118 g)"


def test_multiple_lines_all_succeed():
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT):
        res = _post(["2 eggs", "1 cup rice", "banana"])
    assert res.status_code == 200
    body = res.json()
    assert len(body["items"]) == 3
    assert body["skipped"] == 0
    # original_line preserved for each
    assert body["items"][0]["original_line"] == "2 eggs"
    assert body["items"][2]["original_line"] == "banana"


def test_blank_lines_are_skipped():
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT):
        res = _post(["banana", "", "  ", "2 eggs"])
    assert res.status_code == 200
    body = res.json()
    assert body["skipped"] == 2
    assert len(body["items"]) == 2


def test_all_blank_returns_empty_items():
    res = _post(["", "   ", "\t"])
    assert res.status_code == 200
    body = res.json()
    assert body["items"] == []
    assert body["skipped"] == 3


def test_whitespace_trimmed_before_routing():
    calls = []

    def capture(q):
        calls.append(q)
        return _GOOD_RESULT

    with patch("app.routers.food.route_food_query", side_effect=capture):
        _post(["  banana  "])

    assert calls == ["banana"]


# ── Error handling per line ───────────────────────────────────────────────────

def test_failed_line_returns_parse_error_item():
    def boom(q):
        raise RuntimeError("USDA timeout")

    with patch("app.routers.food.route_food_query", side_effect=boom):
        res = _post(["banana"])

    assert res.status_code == 200   # endpoint itself succeeds
    body = res.json()
    item = body["items"][0]
    assert item["parse_error"]   is True
    assert "USDA timeout" in item["error_message"]
    assert item["calories"]      == 0.0
    assert item["protein"]       == 0.0
    assert item["carbs"]         == 0.0
    assert item["fat"]           == 0.0
    assert item["original_line"] == "banana"
    assert item["name"]          == "banana"


def test_mixed_success_and_failure():
    def selective(q):
        if q == "bad item":
            raise ValueError("unknown food")
        return _GOOD_RESULT

    with patch("app.routers.food.route_food_query", side_effect=selective):
        res = _post(["banana", "bad item", "2 eggs"])

    assert res.status_code == 200
    items = res.json()["items"]
    assert items[0]["parse_error"] is False
    assert items[1]["parse_error"] is True
    assert items[2]["parse_error"] is False


# ── Limit enforcement ─────────────────────────────────────────────────────────

def test_exactly_max_lines_is_accepted():
    lines = [f"food {i}" for i in range(MAX_MULTI_LINES)]
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT):
        res = _post(lines)
    assert res.status_code == 200
    assert len(res.json()["items"]) == MAX_MULTI_LINES


def test_over_limit_returns_400():
    lines = [f"food {i}" for i in range(MAX_MULTI_LINES + 1)]
    res = _post(lines)
    assert res.status_code == 400
    assert "Maximum" in res.json()["detail"]
    assert str(MAX_MULTI_LINES) in res.json()["detail"]


def test_blank_lines_do_not_count_toward_limit():
    # MAX_MULTI_LINES good lines + blanks interspersed — should still be accepted.
    lines = []
    for i in range(MAX_MULTI_LINES):
        lines.append(f"food {i}")
        lines.append("")          # blank between each good line
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT):
        res = _post(lines)
    assert res.status_code == 200
    assert len(res.json()["items"]) == MAX_MULTI_LINES


def test_one_over_limit_with_blanks_still_rejected():
    # MAX_MULTI_LINES + 1 non-blank lines, with extra blanks — blanks don't save it.
    lines = [""] + [f"food {i}" for i in range(MAX_MULTI_LINES + 1)] + [""]
    res = _post(lines)
    assert res.status_code == 400


# ── Response shape completeness ───────────────────────────────────────────────

def test_all_required_fields_present():
    with patch("app.routers.food.route_food_query", return_value=_GOOD_RESULT):
        res = _post(["banana"])
    item = res.json()["items"][0]
    required = {
        "original_line", "name", "calories", "protein", "carbs", "fat",
        "source_type", "confidence", "is_estimated", "serving_description",
        "parse_error", "error_message",
    }
    assert required.issubset(item.keys())
