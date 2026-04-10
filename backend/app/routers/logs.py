from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# Temporary in-memory storage. This list lives in memory only.
# All entries are lost when the server restarts.
food_logs = []


class FoodLog(BaseModel):
    name: str
    calories: int
    protein: int
    carbs: int
    fat: int


@router.post("/logs")
def add_log(entry: FoodLog):
    food_logs.append(entry.model_dump())
    return {"message": "Food logged successfully", "entry": entry}


@router.get("/logs")
def get_logs():
    return {"logs": food_logs}
