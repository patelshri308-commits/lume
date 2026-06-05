"""
Weight prediction service — V1 physics-based model.

All functions are pure (no DB, no I/O) so they can be unit-tested directly.
The router is responsible for fetching data and calling compute_weight_prediction.
"""
from __future__ import annotations

import statistics
from datetime import date
from typing import Optional

# ── Constants ────────────────────────────────────────────────────────────────

ACTIVITY_MULTIPLIERS: dict[str, float] = {
    "sedentary":   1.2,
    "light":       1.375,
    "moderate":    1.55,
    "active":      1.725,
    "very_active": 1.9,
}

KCAL_PER_KG = 7700          # 3500 kcal ≈ 1 lb; 1 lb = 0.4536 kg → ~7700 kcal/kg
WINDOW_DAYS = 14
GOAL_REACHED_KG = 0.5       # within this distance of goal → consider goal reached
MIN_DAYS_MEDIUM   = 5       # < 5 logged days → low confidence
MIN_DAYS_HIGH     = 10      # < 10 logged days → medium confidence
MAX_STALENESS_LOW = 14      # > 14 days since last weight log → low confidence
MAX_STALENESS_MED = 3       # > 3 days → medium confidence
HIGH_VARIANCE_MED = 400     # kcal std dev → medium confidence
HIGH_VARIANCE_LOW = 800     # kcal std dev → medium confidence (not low on its own)


# ── BMR helpers ──────────────────────────────────────────────────────────────

def mifflin_bmr(
    weight_kg: float,
    height_cm: float,
    age: int,
    sex: str,
) -> float:
    """Mifflin–St Jeor BMR.  sex must be 'male', 'female', or 'other'."""
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    if sex == "male":
        return base + 5
    if sex == "female":
        return base - 161
    # 'other' → average of male/female offsets: (5 + -161) / 2 = -78
    return base - 78


# ── Confidence scorer ─────────────────────────────────────────────────────────

def _confidence(
    days_logged: int,
    days_in_window: int,
    weight_staleness_days: Optional[int],
    profile_complete: bool,
    calorie_std: float,
) -> tuple[str, str]:
    """Return (tier, note).  tier is 'high' | 'medium' | 'low'."""

    # Signal 1 — data density (hard low floor)
    if days_logged < MIN_DAYS_MEDIUM:
        return (
            "low",
            f"Only {days_logged} of the last {days_in_window} days have food logs",
        )

    # Signal 2 — profile completeness (hard low floor)
    if not profile_complete:
        return "low", "Profile is incomplete — add height, age, and sex for predictions"

    # Start optimistic; degrade on soft signals.
    tier = "high"
    notes: list[str] = []

    # Signal 3 — weight log staleness
    if weight_staleness_days is None:
        tier = "low"
        notes.append("no weight entry found — log your weight for a better estimate")
    elif weight_staleness_days > MAX_STALENESS_LOW:
        tier = "low"
        notes.append(f"weight was last recorded {weight_staleness_days} days ago")
    elif weight_staleness_days > MAX_STALENESS_MED:
        if tier == "high":
            tier = "medium"
        notes.append(f"weight was last recorded {weight_staleness_days} days ago")

    # Signal 4 — data density (soft medium)
    if days_logged < MIN_DAYS_HIGH:
        if tier == "high":
            tier = "medium"
        notes.append(f"{days_logged} of the last {days_in_window} days have food logs")

    # Signal 5 — calorie variance
    if calorie_std > HIGH_VARIANCE_MED:
        if tier == "high":
            tier = "medium"
        notes.append("high day-to-day calorie variation detected")

    if tier == "low":
        return "low", "; ".join(notes) if notes else "insufficient data for a reliable estimate"

    if notes:
        return tier, "Based on data where " + notes[0]

    return "high", f"Based on {days_logged} of the last {days_in_window} days of food logs"


# ── Main computation ──────────────────────────────────────────────────────────

def compute_weight_prediction(
    *,
    weight_kg: float,
    weight_log_date: Optional[date],
    height_cm: Optional[float],
    age: Optional[int],
    sex: Optional[str],
    activity_level: str,
    daily_calories: list[float],
    days_in_window: int,
    today: date,
    goal_weight_kg: Optional[float] = None,
) -> dict:
    """
    Compute a V1 physics-based weight prediction for one user.

    All inputs are plain Python values — no ORM objects, no I/O.
    Returns a dict matching the /prediction/weight response shape.
    """

    # ── Weight staleness ─────────────────────────────────────────────────────
    staleness: Optional[int]
    if weight_log_date is not None:
        staleness = (today - weight_log_date).days
    else:
        staleness = None    # using profile fallback — treat as unknown

    # ── BMR / TDEE ───────────────────────────────────────────────────────────
    profile_complete = all(v is not None for v in (height_cm, age, sex))

    bmr: Optional[float] = None
    tdee: Optional[float] = None
    if profile_complete:
        assert height_cm is not None and age is not None and sex is not None
        bmr  = round(mifflin_bmr(weight_kg, height_cm, age, sex), 1)
        mult = ACTIVITY_MULTIPLIERS.get(activity_level, ACTIVITY_MULTIPLIERS["moderate"])
        tdee = round(bmr * mult, 1)

    # ── Average calories (logged days only) ──────────────────────────────────
    days_logged = len(daily_calories)
    avg_daily_calories: Optional[float] = None
    calorie_std: float = 0.0
    if days_logged > 0:
        avg_daily_calories = round(sum(daily_calories) / days_logged, 1)
    if days_logged >= 2:
        calorie_std = statistics.stdev(daily_calories)

    # ── Balance and projections ──────────────────────────────────────────────
    daily_balance:          Optional[float] = None
    weekly_change_kg:       Optional[float] = None
    projected_change_30d_kg: Optional[float] = None
    projected_weight_30d_kg: Optional[float] = None

    if avg_daily_calories is not None and tdee is not None:
        daily_balance = round(avg_daily_calories - tdee, 1)
        weekly_change_kg = round((daily_balance * 7) / KCAL_PER_KG, 2)
        raw_change_30d = (daily_balance * 30) / KCAL_PER_KG
        projected_change_30d_kg = round(raw_change_30d, 2)
        projected_weight_30d_kg = round(
            max(30.0, weight_kg + raw_change_30d), 2  # floor at 30 kg
        )

    # ── Confidence ───────────────────────────────────────────────────────────
    confidence, confidence_note = _confidence(
        days_logged=days_logged,
        days_in_window=days_in_window,
        weight_staleness_days=staleness,
        profile_complete=profile_complete,
        calorie_std=calorie_std,
    )

    return {
        "latest_weight_kg":        round(weight_kg, 2),
        "weight_log_date":         weight_log_date.isoformat() if weight_log_date else None,
        "bmr":                     bmr,
        "tdee":                    tdee,
        "avg_daily_calories":      avg_daily_calories,
        "days_logged":             days_logged,
        "days_in_window":          days_in_window,
        "daily_balance":           daily_balance,
        "weekly_change_kg":        weekly_change_kg,
        "projected_change_30d_kg": projected_change_30d_kg,
        "projected_weight_30d_kg": projected_weight_30d_kg,
        "confidence":              confidence,
        "confidence_note":         confidence_note,
    }
