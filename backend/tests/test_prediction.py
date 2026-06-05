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

    # With uniform calories, weekly_change_kg == (balance * 7) / 7700
    expected_balance = 2200.0 - result["tdee"]
    assert result["daily_balance"] == pytest.approx(expected_balance, abs=0.2)
    assert result["weekly_change_kg"] == pytest.approx((expected_balance * 7) / KCAL_PER_KG, abs=0.01)

    # 30-day projection derives directly from daily_balance, not from weekly_change_kg,
    # so compare against the same formula the service uses (avoids rounding cascade).
    expected_30d_change = round((result["daily_balance"] * 30) / KCAL_PER_KG, 2)
    assert result["projected_change_30d_kg"] == pytest.approx(expected_30d_change, abs=0.01)
    assert result["projected_weight_30d_kg"] == pytest.approx(
        75.0 + expected_30d_change, abs=0.01
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
