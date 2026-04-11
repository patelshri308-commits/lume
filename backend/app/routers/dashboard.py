from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.database import get_db
from app import models

router = APIRouter()


@router.get("/dashboard/daily")
def get_daily_summary(db: Session = Depends(get_db)):
    result = db.query(
        func.coalesce(func.sum(models.FoodLog.calories), 0).label("total_calories"),
        func.coalesce(func.sum(models.FoodLog.protein),  0).label("total_protein"),
        func.coalesce(func.sum(models.FoodLog.carbs),    0).label("total_carbs"),
        func.coalesce(func.sum(models.FoodLog.fat),      0).label("total_fat"),
        func.count(models.FoodLog.id).label("entries_count"),
    ).one()

    return {
        "total_calories": result.total_calories,
        "total_protein":  result.total_protein,
        "total_carbs":    result.total_carbs,
        "total_fat":      result.total_fat,
        "entries_count":  result.entries_count,
    }
