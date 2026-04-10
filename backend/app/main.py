from fastapi import FastAPI
from app.routers import health, food

app = FastAPI()

app.include_router(health.router)
app.include_router(food.router)
