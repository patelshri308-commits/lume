from sqlalchemy import Column, Integer, Float, String
from app.database import Base


class FoodLog(Base):
    """Represents a single logged food entry in the database."""
    __tablename__ = "food_logs"

    id       = Column(Integer, primary_key=True, index=True)
    name     = Column(String,  nullable=False)
    calories = Column(Float,   nullable=False)
    protein  = Column(Float,   nullable=False)
    carbs    = Column(Float,   nullable=False)
    fat      = Column(Float,   nullable=False)
