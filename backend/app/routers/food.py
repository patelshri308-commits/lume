from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services.nutrition_service import get_nutrition
from app.services.barcode_service import lookup_barcode, BarcodeNotFoundError, BarcodeProviderError

router = APIRouter()


class FoodSearchRequest(BaseModel):
    query: str


class BarcodeRequest(BaseModel):
    barcode: str


@router.post("/food/search")
def search_food(body: FoodSearchRequest):
    nutrition = get_nutrition(body.query)
    return {"name": body.query, **nutrition}


@router.post("/food/barcode")
def scan_barcode(body: BarcodeRequest):
    code = body.barcode.strip()

    if not code:
        raise HTTPException(status_code=400, detail="Barcode must not be empty.")

    try:
        return lookup_barcode(code)
    except BarcodeNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"No product found for barcode {code!r}.",
        )
    except BarcodeProviderError:
        raise HTTPException(
            status_code=502,
            detail="Barcode lookup service is temporarily unavailable. Please try again.",
        )
