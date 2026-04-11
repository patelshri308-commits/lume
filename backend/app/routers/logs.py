from fastapi import APIRouter, Depends
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


@router.post("/logs")
def add_log(entry: CreateFoodLog, db: Session = Depends(get_db)):
    db_log = models.FoodLog(
        name=entry.name,
        calories=entry.calories,
        protein=entry.protein,
        carbs=entry.carbs,
        fat=entry.fat,
    )
    db.add(db_log)
    db.commit()
    db.refresh(db_log)
    return {"message": "Food logged successfully", "entry": db_log}


@router.get("/logs")
def get_logs(db: Session = Depends(get_db)):
    logs = db.query(models.FoodLog).all()
    return {"logs": logs}
