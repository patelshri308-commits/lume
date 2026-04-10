from fastapi import FastAPI
from app.routers import health, food, logs, dashboard

app = FastAPI()

app.include_router(health.router)
app.include_router(food.router)
app.include_router(logs.router)
app.include_router(dashboard.router)
