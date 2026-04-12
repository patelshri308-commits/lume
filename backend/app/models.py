import datetime
from sqlalchemy import Column, Integer, Float, String, Date, DateTime
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
