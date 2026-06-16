import re
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from app.services.query_router import route_food_query
from app.services.barcode_service import lookup_barcode, BarcodeNotFoundError, BarcodeProviderError
from app.services.multi_parser import split_to_lines
from app.auth import get_current_user

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
    # text: raw multi-format input — preferred; split_to_lines() handles all
    #       separator styles (newline, comma, semicolon, "and").
    # lines: pre-split list — kept for backwards compatibility with existing
    #        callers and tests.  Mutually exclusive with text; text wins.
    text:  Optional[str]       = None
    lines: Optional[List[str]] = None


@router.post("/food/search")
def search_food(body: FoodSearchRequest, _: str = Depends(get_current_user)):
    return route_food_query(body.query)


@router.post("/food/barcode")
def scan_barcode(body: BarcodeRequest, _: str = Depends(get_current_user)):
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
def parse_multi(body: ParseMultiRequest, _: str = Depends(get_current_user)):
    """
    Parse multiple food items in one request.  Mirrors /food/search but accepts
    free-form meal text or a pre-split list of food strings.

    Accepted input shapes (mutually exclusive; text takes priority):
      text  — raw meal string.  split_to_lines() handles newlines, commas,
               semicolons, and simple "and" lists automatically.
      lines — pre-split list (legacy; kept for backwards compatibility).

    - More than MAX_MULTI_LINES resolved items → HTTP 400.
    - Each item is sent through route_food_query independently.
    - An item that raises is returned as parse_error=True with zeroed macros.
    """
    if body.text is not None:
        non_blank = split_to_lines(body.text)
        skipped   = 0
    elif body.lines is not None:
        non_blank = [line for line in body.lines if line.strip()]
        skipped   = len(body.lines) - len(non_blank)
    else:
        raise HTTPException(status_code=422, detail="Provide either 'text' or 'lines'.")

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
