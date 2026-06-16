import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app import models
from app.auth import get_current_user

router = APIRouter()


class CreateFoodLog(BaseModel):
    """Shape of the request body for POST /logs."""
    name:     str            = Field(..., min_length=1, max_length=200)
    calories: float          = Field(..., ge=0, le=10_000)
    protein:  float          = Field(..., ge=0, le=1_000)
    carbs:    float          = Field(..., ge=0, le=1_000)
    fat:      float          = Field(..., ge=0, le=1_000)
    log_date: Optional[str]  = None  # YYYY-MM-DD; defaults to today if omitted
    # Nutrition-source metadata — optional so existing clients keep working.
    source_type:         Optional[str]   = Field(None, max_length=50)
    confidence:          Optional[float] = Field(None, ge=0.0, le=1.0)
    is_estimated:        Optional[bool]  = None
    serving_description: Optional[str]  = Field(None, max_length=200)
    # Serving metadata — optional; omit for old-style logs without serving context.
    serving_quantity: Optional[float] = Field(None, gt=0, le=100)
    serving_unit:     Optional[str]   = Field(None, max_length=50)
    serving_grams:    Optional[float] = Field(None, ge=0, le=10_000)
    # Immutable per-1-serving base nutrition — stored so future edits can rescale.
    base_calories: Optional[float] = Field(None, ge=0, le=10_000)
    base_protein:  Optional[float] = Field(None, ge=0, le=1_000)
    base_carbs:    Optional[float] = Field(None, ge=0, le=1_000)
    base_fat:      Optional[float] = Field(None, ge=0, le=1_000)

    @field_validator("log_date")
    @classmethod
    def validate_log_date(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        try:
            datetime.date.fromisoformat(v)
        except ValueError:
            raise ValueError("log_date must be YYYY-MM-DD")
        return v


class UpdateFoodLog(BaseModel):
    """Shape of the request body for PATCH /logs/{log_id}.
    All fields are optional — only the ones supplied will be updated.

    When serving_quantity is provided and the row has base nutrition values,
    macros are recomputed automatically from base × quantity.
    Manual macro fields (calories/protein/carbs/fat) are used only when the
    row has no base nutrition (old rows) or when serving_quantity is absent.
    """
    name:             Optional[str]   = Field(None, min_length=1, max_length=200)
    calories:         Optional[float] = Field(None, ge=0, le=10_000)
    protein:          Optional[float] = Field(None, ge=0, le=1_000)
    carbs:            Optional[float] = Field(None, ge=0, le=1_000)
    fat:              Optional[float] = Field(None, ge=0, le=1_000)
    serving_quantity: Optional[float] = Field(None, gt=0, le=100)


class FoodLogOut(BaseModel):
    """Serialised shape returned by GET /logs and POST /logs.

    Using an explicit Pydantic schema (rather than returning raw SQLAlchemy
    objects) lets us coerce is_estimated=None → False for old rows that
    pre-date the metadata columns, so the frontend always receives a boolean.
    """
    model_config = ConfigDict(from_attributes=True)

    id:         int
    user_id:    str
    name:       str
    calories:   float
    protein:    float
    carbs:      float
    fat:        float
    log_date:   datetime.date
    created_at: datetime.datetime
    source_type:         Optional[str]   = None
    confidence:          Optional[float] = None
    is_estimated:        bool            = False  # NULL in old rows → False
    serving_description: Optional[str]   = None
    # Serving metadata — None on old rows.
    serving_quantity: Optional[float] = None
    serving_unit:     Optional[str]   = None
    serving_grams:    Optional[float] = None
    base_calories:    Optional[float] = None
    base_protein:     Optional[float] = None
    base_carbs:       Optional[float] = None
    base_fat:         Optional[float] = None


@router.post("/logs")
def add_log(
    entry: CreateFoodLog,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    if entry.log_date is not None:
        try:
            log_date = datetime.date.fromisoformat(entry.log_date)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail="Invalid log_date format. Use YYYY-MM-DD.",
            )
    else:
        log_date = datetime.datetime.utcnow().date()

    db_log = models.FoodLog(
        user_id=user_id,
        name=entry.name,
        calories=entry.calories,
        protein=entry.protein,
        carbs=entry.carbs,
        fat=entry.fat,
        log_date=log_date,
        source_type=entry.source_type,
        confidence=entry.confidence,
        is_estimated=entry.is_estimated,
        serving_description=entry.serving_description,
        serving_quantity=entry.serving_quantity,
        serving_unit=entry.serving_unit,
        serving_grams=entry.serving_grams,
        base_calories=entry.base_calories,
        base_protein=entry.base_protein,
        base_carbs=entry.base_carbs,
        base_fat=entry.base_fat,
    )
    db.add(db_log)
    db.commit()
    db.refresh(db_log)
    return {"message": "Food logged successfully", "entry": FoodLogOut.model_validate(db_log)}


@router.get("/logs")
def get_logs(
    date: Optional[str] = Query(default=None, description="Filter by date (YYYY-MM-DD). Defaults to today."),
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
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
        filter_date = datetime.datetime.utcnow().date()

    logs = (
        db.query(models.FoodLog)
        .filter(
            models.FoodLog.user_id == user_id,
            models.FoodLog.log_date == filter_date,
        )
        .order_by(models.FoodLog.id.desc())
        .all()
    )
    return {"logs": [FoodLogOut.model_validate(log) for log in logs]}


@router.patch("/logs/{log_id}")
def update_log(
    log_id: int,
    updates: UpdateFoodLog,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    db_log = (
        db.query(models.FoodLog)
        .filter(
            models.FoodLog.id == log_id,
            models.FoodLog.user_id == user_id,
        )
        .first()
    )
    if not db_log:
        # Return 404 whether the log doesn't exist or belongs to another user
        # so we don't leak the existence of other users' data.
        raise HTTPException(status_code=404, detail="Log not found")

    # Apply only the fields the caller actually sent.
    if updates.name is not None:
        db_log.name = updates.name

    if updates.serving_quantity is not None and db_log.base_calories is not None:
        # Serving-mode edit: recompute macros from the immutable base nutrition.
        qty = updates.serving_quantity
        db_log.serving_quantity = qty
        db_log.calories = round(db_log.base_calories * qty, 1)
        db_log.protein  = round((db_log.base_protein or 0) * qty, 1)
        db_log.carbs    = round((db_log.base_carbs   or 0) * qty, 1)
        db_log.fat      = round((db_log.base_fat     or 0) * qty, 1)
    else:
        # Manual macro edit — used for old rows that have no base nutrition.
        if updates.calories is not None: db_log.calories = updates.calories
        if updates.protein  is not None: db_log.protein  = updates.protein
        if updates.carbs    is not None: db_log.carbs    = updates.carbs
        if updates.fat      is not None: db_log.fat      = updates.fat

    db.commit()
    db.refresh(db_log)
    return {"message": "Log updated successfully", "entry": db_log}


@router.delete("/logs/{log_id}")
def delete_log(
    log_id: int,
    db: Session = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    db_log = (
        db.query(models.FoodLog)
        .filter(
            models.FoodLog.id == log_id,
            models.FoodLog.user_id == user_id,
        )
        .first()
    )
    if not db_log:
        # Return 404 whether the log doesn't exist or belongs to another user
        # so we don't leak the existence of other users' data.
        raise HTTPException(status_code=404, detail="Log not found")
    db.delete(db_log)
    db.commit()
    return {"message": "Log deleted successfully"}
