import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
from app.services.query_router import route_food_query
from app.services.barcode_service import lookup_barcode, BarcodeNotFoundError, BarcodeProviderError

MAX_MULTI_LINES = 15

# Standard barcode formats (EAN-8, EAN-13, UPC-A/E) are 6–14 digits.
# QR codes and other non-numeric codes are rejected at this layer.
_BARCODE_RE = re.compile(r"^\d{6,14}$")

router = APIRouter()


class FoodSearchRequest(BaseModel):
    query: str


class BarcodeRequest(BaseModel):
    barcode: str


class ParseMultiRequest(BaseModel):
    lines: List[str]


@router.post("/food/search")
def search_food(body: FoodSearchRequest):
    return route_food_query(body.query)


@router.post("/food/barcode")
def scan_barcode(body: BarcodeRequest):
    code = body.barcode.strip()

    if not code:
        raise HTTPException(status_code=400, detail="Barcode must not be empty.")

    if not _BARCODE_RE.match(code):
        raise HTTPException(
            status_code=400,
            detail="Invalid barcode format. Expected 6–14 digits (EAN/UPC). QR codes are not supported.",
        )

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
