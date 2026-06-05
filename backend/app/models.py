import datetime
from sqlalchemy import Boolean, Column, Integer, Float, Numeric, String, Date, DateTime, text
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

    # Serving metadata — nullable; absent on rows created before this migration.
    # serving_quantity: how many servings the user chose (e.g. 2.0)
    # serving_unit:     unit label shown in the UI (e.g. "serving", "g")
    # serving_grams:    grams per serving — reserved for future weight-based scaling
    serving_quantity = Column(Float,  nullable=True)
    serving_unit     = Column(String, nullable=True)
    serving_grams    = Column(Float,  nullable=True)

    # Immutable base nutrition per 1 serving.
    # Written once at creation; used to recompute macros when serving_quantity changes.
    # NULL on rows created before this migration — those rows use manual macro editing.
    base_calories = Column(Float, nullable=True)
    base_protein  = Column(Float, nullable=True)
    base_carbs    = Column(Float, nullable=True)
    base_fat      = Column(Float, nullable=True)


class WeightLog(Base):
    """One row per user per calendar day — mirrors the Supabase weight_logs table."""
    __tablename__ = "weight_logs"
    # Table was created via Supabase migration; create_all skips it (IF NOT EXISTS).
    # id is uuid in Postgres; String works for read-only ORM queries.
    id         = Column(String,              primary_key=True)
    user_id    = Column(String,              nullable=False, index=True)
    log_date   = Column(Date,               nullable=False)
    weight_kg  = Column(Numeric,            nullable=False)
    note       = Column(String,             nullable=True)
    created_at = Column(DateTime(timezone=True), nullable=False)
    updated_at = Column(DateTime(timezone=True), nullable=False)


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
