import datetime
from typing import Optional
from sqlalchemy import distinct

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app import models
from app.auth import get_current_user

router = APIRouter()


@router.get("/dashboard/daily")
def get_daily_summary(
    date: Optional[str] = Query(default=None, description="Date to summarise (YYYY-MM-DD). Defaults to today."),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    if date is not None:
        try:
            filter_date = datetime.date.fromisoformat(date)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="Invalid date format. Use YYYY-MM-DD, e.g. 2026-04-12.",
            )
    else:
        filter_date = datetime.datetime.utcnow().date()

    result = db.query(
        func.coalesce(func.sum(models.FoodLog.calories), 0).label("total_calories"),
        func.coalesce(func.sum(models.FoodLog.protein),  0).label("total_protein"),
        func.coalesce(func.sum(models.FoodLog.carbs),    0).label("total_carbs"),
        func.coalesce(func.sum(models.FoodLog.fat),      0).label("total_fat"),
        func.count(models.FoodLog.id).label("entries_count"),
    ).filter(
        models.FoodLog.user_id == user_id,
        models.FoodLog.log_date == filter_date,
    ).one()

    return {
        "date":            filter_date.isoformat(),
        "total_calories":  result.total_calories,
        "total_protein":   result.total_protein,
        "total_carbs":     result.total_carbs,
        "total_fat":       result.total_fat,
        "entries_count":   result.entries_count,
    }


@router.get("/dashboard/weekly")
def get_weekly_summary(
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    today = datetime.datetime.utcnow().date()
    # Build the 7-day window: 6 days ago through today (oldest → newest)
    days = [today - datetime.timedelta(days=i) for i in range(6, -1, -1)]

    start_date = days[0]   # 6 days ago
    end_date   = days[-1]  # today

    # Fetch all matching rows in one query, grouped by date
    rows = (
        db.query(
            models.FoodLog.log_date,
            func.coalesce(func.sum(models.FoodLog.calories), 0).label("total_calories"),
        )
        .filter(
            models.FoodLog.user_id == user_id,
            models.FoodLog.log_date >= start_date,
            models.FoodLog.log_date <= end_date,
        )
        .group_by(models.FoodLog.log_date)
        .all()
    )

    # Index results by date so we can fill in zero-calorie days easily
    calories_by_date = {row.log_date: row.total_calories for row in rows}

    return [
        {
            "date":           day.isoformat(),
            "total_calories": calories_by_date.get(day, 0),
        }
        for day in days
    ]


@router.get("/dashboard/food-streak")
def get_food_streak(
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    today = datetime.datetime.utcnow().date()

    # Fetch all distinct dates the user has logged food, most recent first.
    # Limit to 366 days — no streak can be longer than a year.
    rows = (
        db.query(distinct(models.FoodLog.log_date))
        .filter(
            models.FoodLog.user_id == user_id,
            models.FoodLog.log_date <= today,
            models.FoodLog.log_date >= today - datetime.timedelta(days=365),
        )
        .order_by(models.FoodLog.log_date.desc())
        .all()
    )

    logged_dates = {row[0] for row in rows}

    # Walk backward from today counting consecutive days with at least one log.
    streak = 0
    cursor = today
    while cursor in logged_dates:
        streak += 1
        cursor -= datetime.timedelta(days=1)

    return {"streak": streak}
