import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import health, food, logs, dashboard
from app.database import engine, Base
from app import models  # noqa: F401 — registers models with Base before create_all

app = FastAPI()

# ---------------------------------------------------------------------------
# CORS — allow all origins in development.
# Before going to production, replace ["*"] with your frontend's exact domain,
# e.g. allow_origins=["https://your-app.com"]
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Create all database tables on startup if they don't already exist.
Base.metadata.create_all(bind=engine)

app.include_router(health.router)
app.include_router(food.router)
app.include_router(logs.router)
app.include_router(dashboard.router)
