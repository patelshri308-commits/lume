from fastapi import APIRouter
from pydantic import BaseModel
from app.services.nutrition_service import get_mock_nutrition

router = APIRouter()


class FoodSearchRequest(BaseModel):
    query: str


@router.post("/food/search")
def search_food(body: FoodSearchRequest):
    nutrition = get_mock_nutrition(body.query)
    return {"name": body.query, **nutrition}
