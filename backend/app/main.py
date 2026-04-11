from fastapi import FastAPI
from app.routers import health, food, logs, dashboard
from app.database import engine, Base
from app import models  # noqa: F401 — registers models with Base before create_all

app = FastAPI()

# Create all database tables on startup if they don't already exist.
Base.metadata.create_all(bind=engine)

app.include_router(health.router)
app.include_router(food.router)
app.include_router(logs.router)
app.include_router(dashboard.router)
