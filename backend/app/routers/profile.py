import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app import models
from app.auth import get_current_user

router = APIRouter()


class UpsertProfile(BaseModel):
    """
    Request body for PUT /profile.

    All fields are optional — only the ones supplied are written.
    On a new row the DB column defaults (goal_type='maintain',
    activity_level='moderate', onboarding_completed=false) fill the gaps.
    On an existing row, unset fields are left untouched.
    """
    display_name:         Optional[str]   = None
    sex:                  Optional[str]   = None   # 'male' | 'female' | 'other'
    age:                  Optional[int]   = None
    height_cm:            Optional[float] = None
    weight_kg:            Optional[float] = None
    goal_weight_kg:       Optional[float] = None
    goal_type:            Optional[str]   = None   # 'lose' | 'maintain' | 'gain'
    activity_level:       Optional[str]   = None   # 'sedentary'|'light'|'moderate'|'active'|'very_active'
    onboarding_completed: Optional[bool]  = None


@router.get("/profile")
def get_profile(
    db:      Session = Depends(get_db),
    user_id: str     = Depends(get_current_user),
):
    """
    Return the authenticated user's profile row, or {profile: null} if they
    haven't completed setup yet.
    """
    profile = (
        db.query(models.UserProfile)
        .filter(models.UserProfile.user_id == user_id)
        .first()
    )
    return {"profile": profile}  # None serialises to JSON null


@router.put("/profile")
def upsert_profile(
    data:    UpsertProfile,
    db:      Session = Depends(get_db),
    user_id: str     = Depends(get_current_user),
):
    """
    Create or update the authenticated user's profile (upsert).

    - If no row exists for this user, a new one is inserted.
    - If a row already exists, only the fields explicitly supplied in the
      request body are overwritten; everything else is left as-is.
    - updated_at is always set to the current UTC time on every call.
    """
    profile = (
        db.query(models.UserProfile)
        .filter(models.UserProfile.user_id == user_id)
        .first()
    )

    now = datetime.datetime.now(datetime.timezone.utc)

    if profile is None:
        # First time — create a bare row so setattr loop below can populate it.
        profile = models.UserProfile(user_id=user_id, created_at=now, updated_at=now)
        db.add(profile)

    # Apply only the fields the caller actually sent.
    # exclude_unset=True skips fields absent from the JSON body so existing DB
    # values are preserved.  model_dump is Pydantic v2; fall back to .dict() for v1.
    updates = (
        data.model_dump(exclude_unset=True)
        if hasattr(data, "model_dump")
        else data.dict(exclude_unset=True)  # type: ignore[attr-defined]
    )
    for field, value in updates.items():
        setattr(profile, field, value)

    # Always bump updated_at, regardless of which fields changed.
    profile.updated_at = now

    db.commit()
    db.refresh(profile)
    return {"profile": profile}
