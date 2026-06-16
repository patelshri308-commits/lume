import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routers import health, food, logs, dashboard, profile, prediction
from app.database import engine, Base
from app import models  # noqa: F401 — registers models with Base before create_all

app = FastAPI()

# ---------------------------------------------------------------------------
# CORS
# In local dev (ENVIRONMENT=local or unset), wildcard is allowed.
# In any other environment ALLOWED_ORIGINS must be set explicitly, e.g.:
#   ALLOWED_ORIGINS=https://your-app.com,https://www.your-app.com
# The app refuses to start if ALLOWED_ORIGINS is missing outside local dev,
# so a misconfigured deploy fails loudly rather than silently opening CORS.
# ---------------------------------------------------------------------------
_env = os.getenv("ENVIRONMENT", "local").lower()
_raw_origins = os.getenv("ALLOWED_ORIGINS", "")

if _env != "local" and not _raw_origins:
    raise RuntimeError(
        "ALLOWED_ORIGINS must be set in non-local environments. "
        "Example: ALLOWED_ORIGINS=https://your-app.com"
    )

_origins = _raw_origins.split(",") if _raw_origins else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# create_all is local/test only — production schema is managed by migrations/.
# Set ALLOW_CREATE_ALL=true in local .env or test config to enable.
if os.getenv("ALLOW_CREATE_ALL", "false").lower() == "true":
    Base.metadata.create_all(bind=engine)

app.include_router(health.router)
app.include_router(food.router)
app.include_router(logs.router)
app.include_router(dashboard.router)
app.include_router(profile.router)
app.include_router(prediction.router)
