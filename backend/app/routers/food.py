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


@router.post("/food/parse-multi")
def parse_multi(body: ParseMultiRequest):
    """
    Parse multiple food lines in one request.  Mirrors /food/search but accepts
    a list of lines and returns a result for each non-blank line.

    - Blank / whitespace-only lines are silently skipped (counted in `skipped`).
    - More than MAX_MULTI_LINES non-blank lines → HTTP 400.
    - Each line is sent through route_food_query independently.
    - A line that raises is returned as parse_error=True with zeroed macros.
    - No auth required; no DB writes.
    """
    non_blank = [line for line in body.lines if line.strip()]
    skipped   = len(body.lines) - len(non_blank)

    if len(non_blank) > MAX_MULTI_LINES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many items. Maximum {MAX_MULTI_LINES} non-blank lines per request.",
        )

    items = []
    for line in non_blank:
        try:
            result = route_food_query(line.strip())
            items.append({
                "original_line":     line,
                "name":              result.get("name", line),
                "calories":          result.get("calories", 0.0),
                "protein":           result.get("protein", 0.0),
                "carbs":             result.get("carbs", 0.0),
                "fat":               result.get("fat", 0.0),
                "source_type":       result.get("source_type"),
                "confidence":        result.get("confidence"),
                "is_estimated":      result.get("is_estimated", True),
                "serving_description": result.get("serving_description"),
                "parse_error":       False,
                "error_message":     None,
            })
        except Exception as exc:
            items.append({
                "original_line":     line,
                "name":              line.strip(),
                "calories":          0.0,
                "protein":           0.0,
                "carbs":             0.0,
                "fat":               0.0,
                "source_type":       None,
                "confidence":        None,
                "is_estimated":      True,
                "serving_description": None,
                "parse_error":       True,
                "error_message":     str(exc),
            })

    return {"items": items, "skipped": skipped}
