import datetime

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app import models
from app.auth import get_current_user
from app.services import prediction_service

router = APIRouter()


@router.get("/prediction/weight")
def get_weight_prediction(
    db:      Session = Depends(get_db),
    user_id: str     = Depends(get_current_user),
):
    """
    Return a V1 physics-based weight prediction for the authenticated user.

    Pulls from user_profiles, weight_logs, and food_logs.
    No new tables; no ML.  Always returns HTTP 200 — low data quality is
    expressed via confidence='low' and confidence_note, not a 4xx error.
    """
    today        = datetime.date.today()
    window_start = today - datetime.timedelta(days=prediction_service.WINDOW_DAYS - 1)

    # ── 1. Profile ────────────────────────────────────────────────────────────
    profile = (
        db.query(models.UserProfile)
        .filter(models.UserProfile.user_id == user_id)
        .first()
    )

    # ── 2. Latest weight log ──────────────────────────────────────────────────
    weight_log = (
        db.query(models.WeightLog)
        .filter(models.WeightLog.user_id == user_id)
        .order_by(models.WeightLog.log_date.desc())
        .first()
    )

    # Resolve current weight: prefer weight_logs, fall back to user_profiles.
    if weight_log is not None:
        weight_kg      = float(weight_log.weight_kg)
        weight_log_date = weight_log.log_date
    elif profile is not None and profile.weight_kg is not None:
        weight_kg      = float(profile.weight_kg)
        weight_log_date = None          # profile snapshot; staleness unknown
    else:
        # Nothing to predict from — return a minimal low-confidence response.
        goal_weight_kg_val = (
            float(profile.goal_weight_kg)
            if profile and profile.goal_weight_kg is not None
            else None
        )
        return {
            "latest_weight_kg":        None,
            "weight_log_date":         None,
            "bmr":                     None,
            "tdee":                    None,
            "avg_daily_calories":      None,
            "days_logged":             0,
            "days_in_window":          prediction_service.WINDOW_DAYS,
            "daily_balance":           None,
            "weekly_change_kg":        None,
            "projected_change_30d_kg": None,
            "projected_weight_30d_kg": None,
            "confidence":              "low",
            "confidence_note":         "No weight data found — log your weight to get started",
            "goal_weight_kg":          goal_weight_kg_val,
            "kg_to_goal":              None,
            "goal_direction":          None,
            "estimated_weeks_to_goal": None,
            "projected_goal_date":     None,
        }

    # ── 3. Daily calorie totals for the lookback window ───────────────────────
    calorie_rows = (
        db.query(
            func.sum(models.FoodLog.calories).label("total"),
        )
        .filter(
            models.FoodLog.user_id  == user_id,
            models.FoodLog.log_date >= window_start,
            models.FoodLog.log_date <= today,
        )
        .group_by(models.FoodLog.log_date)
        .all()
    )
    daily_calories = [float(r.total) for r in calorie_rows if r.total is not None]

    # ── 4. Compute and return ─────────────────────────────────────────────────
    return prediction_service.compute_weight_prediction(
        weight_kg      = weight_kg,
        weight_log_date= weight_log_date,
        height_cm      = float(profile.height_cm)      if profile and profile.height_cm      else None,
        age            = profile.age                    if profile                             else None,
        sex            = profile.sex                    if profile                             else None,
        activity_level = profile.activity_level         if profile                             else "moderate",
        daily_calories = daily_calories,
        days_in_window = prediction_service.WINDOW_DAYS,
        today          = today,
        goal_weight_kg = float(profile.goal_weight_kg) if profile and profile.goal_weight_kg else None,
    )
