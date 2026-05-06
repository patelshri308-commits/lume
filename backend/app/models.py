import datetime
from sqlalchemy import Boolean, Column, Integer, Float, Numeric, String, Date, DateTime
from app.database import Base


class FoodLog(Base):
    """Represents a single logged food entry in the database."""
    __tablename__ = "food_logs"

    id         = Column(Integer,  primary_key=True, index=True)
    user_id    = Column(String,   nullable=False, index=True)  # Supabase auth UUID
    name       = Column(String,   nullable=False)
    calories   = Column(Float,    nullable=False)
    protein    = Column(Float,    nullable=False)
    carbs      = Column(Float,    nullable=False)
    fat        = Column(Float,    nullable=False)
    log_date   = Column(Date,     nullable=False, default=datetime.date.today)
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)

    # Nutrition-source metadata — nullable so existing rows are unaffected.
    # Added after initial launch; old rows have NULL for all four fields.
    source_type         = Column(String,  nullable=True)   # e.g. "generic", "barcode", "packaged_product"
    confidence          = Column(Float,   nullable=True)   # 0.0–1.0 from query router
    is_estimated        = Column(Boolean, nullable=True)   # None = unknown (old row)
    serving_description = Column(String,  nullable=True)   # e.g. "43 g", "per 100g"


class UserProfile(Base):
    """One row per Supabase auth user — stores profile data used for calorie targets."""
    __tablename__ = "user_profiles"

    # UUID stored as String, consistent with FoodLog.user_id
    user_id              = Column(String,               primary_key=True)
    display_name         = Column(String,               nullable=True)
    sex                  = Column(String,               nullable=True)   # 'male' | 'female' | 'other'
    age                  = Column(Integer,              nullable=True)
    height_cm            = Column(Numeric,              nullable=True)
    weight_kg            = Column(Numeric,              nullable=True)
    goal_type            = Column(String,               nullable=False, default="maintain")
    activity_level       = Column(String,               nullable=False, default="moderate")
    onboarding_completed = Column(Boolean,              nullable=False, default=False)
    # TIMESTAMPTZ — store and retrieve as timezone-aware UTC datetimes
    created_at           = Column(DateTime(timezone=True), nullable=False,
                                  default=lambda: datetime.datetime.now(datetime.timezone.utc))
    updated_at           = Column(DateTime(timezone=True), nullable=False,
                                  default=lambda: datetime.datetime.now(datetime.timezone.utc))
