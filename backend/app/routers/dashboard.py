from fastapi import APIRouter
from app.routers.logs import food_logs

router = APIRouter()


@router.get("/dashboard/daily")
def get_daily_summary():
    total_calories = sum(entry["calories"] for entry in food_logs)
    total_protein  = sum(entry["protein"]  for entry in food_logs)
    total_carbs    = sum(entry["carbs"]    for entry in food_logs)
    total_fat      = sum(entry["fat"]      for entry in food_logs)

    return {
        "total_calories": total_calories,
        "total_protein":  total_protein,
        "total_carbs":    total_carbs,
        "total_fat":      total_fat,
        "entries_count":  len(food_logs),
    }
