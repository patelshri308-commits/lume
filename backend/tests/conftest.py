"""
Load .env before any test module is imported so that module-level
os.getenv() calls (e.g. USDA_API_KEY in nutrition_service.py) pick up
the real values from the project's .env file.

conftest.py is executed by pytest before collection begins, which means
it runs before any service module is imported and before any module-level
constants are evaluated.
"""
from dotenv import load_dotenv

load_dotenv()
