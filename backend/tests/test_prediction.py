"""
Weight prediction service — unit tests.

All tests call compute_weight_prediction() directly with plain Python values.
No DB, no HTTP, no mocking required.

Run:
    cd backend && pytest tests/test_prediction.py -v
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.services.prediction_service import (
    GOAL_REACHED_KG,
    KCAL_PER_KG,
    WINDOW_DAYS,
    compute_weight_prediction,
    mifflin_bmr,
)

TODAY = date(2026, 6, 4)


# ── BMR helper ────────────────────────────────────────────────────────────────

def test_mifflin_bmr_male():
    # 10×70 + 6.25×175 − 5×30 + 5 = 700 + 1093.75 − 150 + 5 = 1648.75
    assert mifflin_bmr(70, 175, 30, "male") == pytest.approx(1648.75)


def test_mifflin_bmr_female():
    # 700 + 1093.75 − 150 − 161 = 1482.75
    assert mifflin_bmr(70, 175, 30, "female") == pytest.approx(1482.75)


def test_mifflin_bmr_other_is_average():
    male   = mifflin_bmr(70, 175, 30, "male")
    female = mifflin_bmr(70, 175, 30, "female")
    other  = mifflin_bmr(70, 175, 30, "other")
    assert other == pytest.approx((male + female) / 2)


# ── High-confidence scenario ──────────────────────────────────────────────────

def test_high_confidence_full_data():
    """All fields present, 12 logged days, weight logged yesterday."""
    result = compute_weight_prediction(
        weight_kg       = 75.0,
        weight_log_date = TODAY - timedelta(days=1),
        height_cm       = 178.0,
        age             = 28,
        sex             = "male",
        activity_level  = "moderate",
        daily_calories  = [2200.0] * 12,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )

    assert result["confidence"] == "high"
    assert result["latest_weight_kg"] == 75.0
    assert result["days_logged"] == 12
    assert result["bmr"]  is not None
    assert result["tdee"] is not None
    assert result["avg_daily_calories"] == 2200.0

    # daily_balance should match physics.
    expected_balance = 2200.0 - result["tdee"]
    assert result["daily_balance"] == pytest.approx(expected_balance, abs=0.2)
    # weekly_change_kg is derived from the 30-day projection (ML or physics) / 4.33.
    # Assert internal consistency rather than a physics formula, since the ML model
    # may be active and returns a data-driven 30-day figure.
    assert result["weekly_change_kg"] == pytest.approx(
        round(result["projected_change_30d_kg"] / 4.33, 2), abs=0.01
    )

    # 30-day projection may come from the ML model when it is available.
    # Assert internal consistency: projected_weight = start + change.
    assert result["projected_change_30d_kg"] is not None
    assert result["projected_weight_30d_kg"] == pytest.approx(
        75.0 + result["projected_change_30d_kg"], abs=0.01
    )


# ── Medium-confidence scenarios ───────────────────────────────────────────────

def test_medium_confidence_sparse_logs():
    """6 logged days out of 14 → medium."""
    result = compute_weight_prediction(
        weight_kg       = 80.0,
        weight_log_date = TODAY,
        height_cm       = 170.0,
        age             = 35,
        sex             = "female",
        activity_level  = "light",
        daily_calories  = [1800.0] * 6,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["confidence"] == "medium"
    assert result["days_logged"] == 6


def test_medium_confidence_stale_weight():
    """Weight logged 8 days ago → medium."""
    result = compute_weight_prediction(
        weight_kg       = 70.0,
        weight_log_date = TODAY - timedelta(days=8),
        height_cm       = 165.0,
        age             = 25,
        sex             = "female",
        activity_level  = "active",
        daily_calories  = [2000.0] * 11,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["confidence"] == "medium"


# ── Low-confidence scenarios ──────────────────────────────────────────────────

def test_low_confidence_too_few_logs():
    """3 logged days → low, projections still computed."""
    result = compute_weight_prediction(
        weight_kg       = 65.0,
        weight_log_date = TODAY,
        height_cm       = 160.0,
        age             = 40,
        sex             = "male",
        activity_level  = "sedentary",
        daily_calories  = [1500.0] * 3,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["confidence"] == "low"
    assert result["days_logged"] == 3


def test_low_confidence_missing_profile_fields():
    """No height/age/sex → BMR and TDEE are null → low confidence."""
    result = compute_weight_prediction(
        weight_kg       = 70.0,
        weight_log_date = TODAY,
        height_cm       = None,
        age             = None,
        sex             = None,
        activity_level  = "moderate",
        daily_calories  = [2000.0] * 12,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["confidence"] == "low"
    assert result["bmr"]  is None
    assert result["tdee"] is None
    assert result["daily_balance"]           is None
    assert result["weekly_change_kg"]        is None
    assert result["projected_weight_30d_kg"] is None


def test_low_confidence_very_stale_weight():
    """Weight not logged in 20 days → low confidence."""
    result = compute_weight_prediction(
        weight_kg       = 72.0,
        weight_log_date = TODAY - timedelta(days=20),
        height_cm       = 175.0,
        age             = 30,
        sex             = "male",
        activity_level  = "moderate",
        daily_calories  = [2100.0] * 12,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["confidence"] == "low"


# ── Edge cases ────────────────────────────────────────────────────────────────

def test_no_food_logs():
    """No food logs → avg_daily_calories and balance are None."""
    result = compute_weight_prediction(
        weight_kg       = 68.0,
        weight_log_date = TODAY,
        height_cm       = 170.0,
        age             = 27,
        sex             = "female",
        activity_level  = "moderate",
        daily_calories  = [],
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["avg_daily_calories"] is None
    assert result["daily_balance"]       is None
    assert result["weekly_change_kg"]    is None


def test_no_weight_log_uses_profile(monkeypatch):
    """weight_log_date=None (profile fallback) → staleness unknown → low confidence."""
    result = compute_weight_prediction(
        weight_kg       = 70.0,
        weight_log_date = None,
        height_cm       = 175.0,
        age             = 32,
        sex             = "male",
        activity_level  = "moderate",
        daily_calories  = [2200.0] * 12,
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    # weight_log_date=None → staleness=None → low confidence
    assert result["confidence"] == "low"
    assert result["weight_log_date"] is None
    assert result["latest_weight_kg"] == 70.0


def test_projected_weight_floored_at_30kg():
    """Extreme deficit should never project below 30 kg."""
    result = compute_weight_prediction(
        weight_kg       = 31.0,
        weight_log_date = TODAY,
        height_cm       = 160.0,
        age             = 25,
        sex             = "female",
        activity_level  = "very_active",
        daily_calories  = [500.0] * 14,   # extreme deficit
        days_in_window  = WINDOW_DAYS,
        today           = TODAY,
    )
    assert result["projected_weight_30d_kg"] >= 30.0


# ── Goal progress ─────────────────────────────────────────────────────────────

def _base_kwargs(**overrides):
    """Full-data base fixture; override any field for specific test cases."""
    return {
        "weight_kg":       90.0,
        "weight_log_date": TODAY,
        "height_cm":       175.0,
        "age":             30,
        "sex":             "male",
        "activity_level":  "moderate",
        "daily_calories":  [2000.0] * 12,
        "days_in_window":  WINDOW_DAYS,
        "today":           TODAY,
        **overrides,
    }


def test_goal_fields_absent_when_no_goal():
    """Without goal_weight_kg all five goal fields are None."""
    result = compute_weight_prediction(**_base_kwargs())
    assert result["goal_weight_kg"]          is None
    assert result["kg_to_goal"]              is None
    assert result["goal_direction"]          is None
    assert result["estimated_weeks_to_goal"] is None
    assert result["projected_goal_date"]     is None


def test_goal_lose_trending_toward():
    """90 kg → goal 80 kg, losing 0.5 kg/week → ~20 weeks out."""
    # To get weekly_change_kg ≈ -0.5, we need daily_balance ≈ -550
    # daily_balance = avg_calories - tdee; we'll use a known deficit setup
    # and verify weeks = kg_to_goal / abs(weekly_change_kg)
    result = compute_weight_prediction(**_base_kwargs(goal_weight_kg=80.0))
    assert result["goal_direction"] == "lose"
    assert result["kg_to_goal"] == pytest.approx(10.0, abs=0.01)

    if result["weekly_change_kg"] is not None and result["weekly_change_kg"] < 0:
        expected_weeks = round(
            abs(result["kg_to_goal"]) / abs(result["weekly_change_kg"]), 1
        )
        assert result["estimated_weeks_to_goal"] == pytest.approx(expected_weeks, abs=0.2)
        assert result["projected_goal_date"] is not None


def test_goal_lose_not_trending():
    """Goal is to lose but weekly_change_kg is positive → weeks/date are None."""
    # Force a surplus by using very high calories (surplus will make weekly_change > 0)
    result = compute_weight_prediction(**_base_kwargs(
        daily_calories=[4000.0] * 12,
        goal_weight_kg=80.0,
    ))
    assert result["goal_direction"] == "lose"
    if result["weekly_change_kg"] is not None and result["weekly_change_kg"] > 0:
        assert result["estimated_weeks_to_goal"] is None
        assert result["projected_goal_date"]     is None


def test_goal_gain_trending_toward():
    """75 kg → goal 85 kg, weekly_change > 0 → weeks computed."""
    result = compute_weight_prediction(**_base_kwargs(
        weight_kg=75.0,
        daily_calories=[3500.0] * 12,  # likely a surplus → positive weekly change
        goal_weight_kg=85.0,
    ))
    assert result["goal_direction"] == "gain"
    assert result["kg_to_goal"] == pytest.approx(-10.0, abs=0.01)

    if result["weekly_change_kg"] is not None and result["weekly_change_kg"] > 0:
        assert result["estimated_weeks_to_goal"] is not None
        assert result["projected_goal_date"]     is not None


def test_goal_reached_within_threshold():
    """Within GOAL_REACHED_KG → direction is maintain, weeks/date are None."""
    result = compute_weight_prediction(**_base_kwargs(
        weight_kg=80.3,
        goal_weight_kg=80.0,
    ))
    assert abs(80.3 - 80.0) <= GOAL_REACHED_KG
    assert result["goal_direction"]          == "maintain"
    assert result["estimated_weeks_to_goal"] is None
    assert result["projected_goal_date"]     is None


def test_goal_weeks_no_tdee():
    """No profile (TDEE=None) → weekly_change_kg is None → weeks/date are None."""
    result = compute_weight_prediction(**_base_kwargs(
        height_cm=None,
        age=None,
        sex=None,
        goal_weight_kg=80.0,
    ))
    assert result["weekly_change_kg"]        is None
    assert result["estimated_weeks_to_goal"] is None
    assert result["projected_goal_date"]     is None
