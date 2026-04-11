import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app import models

router = APIRouter()


class CreateFoodLog(BaseModel):
    """Shape of the request body for POST /logs."""
    name:     str
    calories: float
    protein:  float
    carbs:    float
    fat:      float
    log_date: Optional[str] = None  # YYYY-MM-DD; defaults to today if omitted


@router.post("/logs")
def add_log(entry: CreateFoodLog, db: Session = Depends(get_db)):
    if entry.log_date is not None:
        try:
            log_date = datetime.date.fromisoformat(entry.log_date)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="Invalid log_date format. Use YYYY-MM-DD.",
            )
    else:
        log_date = datetime.date.today()

    db_log = models.FoodLog(
        name=entry.name,
        calories=entry.calories,
        protein=entry.protein,
        carbs=entry.carbs,
        fat=entry.fat,
        log_date=log_date,
    )
    db.add(db_log)
    db.commit()
    db.refresh(db_log)
    return {"message": "Food logged successfully", "entry": db_log}


@router.get("/logs")
def get_logs(
    date: Optional[str] = Query(default=None, description="Filter by date (YYYY-MM-DD). Defaults to today."),
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

    logs = db.query(models.FoodLog).filter(models.FoodLog.log_date == filter_date).all()
    return {"logs": logs}


@router.delete("/logs/{log_id}")
def delete_log(log_id: int, db: Session = Depends(get_db)):
    db_log = db.query(models.FoodLog).filter(models.FoodLog.id == log_id).first()
    if not db_log:
        raise HTTPException(status_code=404, detail="Log not found")
    db.delete(db_log)
    db.commit()
    return {"message": "Log deleted successfully"}
