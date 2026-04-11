import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app import models

router = APIRouter()


@router.get("/dashboard/daily")
def get_daily_summary(
    date: Optional[str] = Query(default=None, description="Date to summarise (YYYY-MM-DD). Defaults to today."),
    db: Session = Depends(get_db),
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
        filter_date = datetime.date.today()

    result = db.query(
        func.coalesce(func.sum(models.FoodLog.calories), 0).label("total_calories"),
        func.coalesce(func.sum(models.FoodLog.protein),  0).label("total_protein"),
        func.coalesce(func.sum(models.FoodLog.carbs),    0).label("total_carbs"),
        func.coalesce(func.sum(models.FoodLog.fat),      0).label("total_fat"),
        func.count(models.FoodLog.id).label("entries_count"),
    ).filter(models.FoodLog.log_date == filter_date).one()

    return {
        "date":            filter_date.isoformat(),
        "total_calories":  result.total_calories,
        "total_protein":   result.total_protein,
        "total_carbs":     result.total_carbs,
        "total_fat":       result.total_fat,
        "entries_count":   result.entries_count,
    }
