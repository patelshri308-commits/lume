from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class FoodSearchRequest(BaseModel):
    query: str


@router.post("/food/search")
def search_food(body: FoodSearchRequest):
    return {
        "name": body.query,
        "calories": 250,
        "protein": 10,
        "carbs": 20,
        "fat": 15,
    }
