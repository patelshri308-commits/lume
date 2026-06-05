# Lume 🍎

A mobile-first calorie tracking application that understands natural language food input and returns nutrition information.

**Status:** Work in progress — MVP in development. Not ready for production use.

---

## About Lume

Lume is designed for solo individuals who want to track their daily food intake without complexity. Simply search for food by typing naturally (e.g., "grilled chicken breast"), log your servings, and see your daily calorie and macro totals at a glance.

**Key Features (Planned MVP):**
- 📝 Natural language food search powered by USDA FoodData Central
- 🔑 Email/password authentication with JWT
- 📊 Daily calorie and macro tracking (calories, protein, carbs, fat)
- 🎯 Personal daily calorie goal tracking
- 🗑️ Log deletion and edit capabilities

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React Native + Expo (Expo Router) |
| **Backend** | FastAPI (Python) |
| **Database** | PostgreSQL (Supabase) |
| **Auth** | JWT with `python-jose` and `bcrypt` |
| **Nutrition Data** | USDA FoodData Central API |
| **State Management** | Zustand (auth) + React Query (server state) |
| **HTTP Client** | Axios |

---

## Project Structure

```
lume/
├── frontend/                    # React Native + Expo
│   ├── app/
│   │   ├── (auth)/             # Auth screens (login, register)
│   │   └── (tabs)/             # Main app (dashboard, search)
│   ├── components/             # Reusable UI components
│   ├── store/                  # Zustand auth store
│   ├── api/                    # API client + functions
│   └── package.json
│
├── backend/                    # FastAPI application
│   ├── app/
│   │   ├── main.py            # FastAPI app factory
│   │   ├── models.py          # SQLAlchemy ORM models
│   │   ├── schemas.py         # Pydantic request/response models
│   │   ├── database.py        # Database connection
│   │   ├── auth.py            # JWT + password utilities
│   │   └── routers/           # API endpoints
│   │       ├── auth.py        # /auth/register, /auth/login
│   │       ├── food.py        # /food/search
│   │       ├── logs.py        # Food log CRUD
│   │       └── dashboard.py   # /dashboard/daily aggregates
│   ├── requirements.txt
│   └── .env.example
│
├── docs/                       # Documentation
├── scripts/                    # Utility scripts
├── SPEC.md                     # Detailed technical specification
└── README.md
```

---

## Getting Started

### Prerequisites

- **Node.js 18+** (for frontend)
- **Python 3.9+** (for backend)
- **PostgreSQL** or Supabase account
- **Git**

### Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Create a Python virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

4. Set up environment variables:
   ```bash
   cp .env.example .env
   ```
   Fill in your Supabase credentials and configuration.

5. Run the backend:
   ```bash
   uvicorn app.main:app --reload
   ```

   The API will be available at `http://localhost:8000`

### Frontend Setup

1. Navigate to the frontend directory:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the Expo development server:
   ```bash
   npm start
   ```

4. Follow the Expo CLI prompts to run on iOS simulator, Android emulator, or web.

---

## API Overview

### Authentication
- **POST** `/api/auth/register` — Create a new account
- **POST** `/api/auth/login` — Log in and receive JWT token

### Food Search
- **GET** `/api/food/search?q=<query>` — Search USDA database for foods

### Food Logs
- **POST** `/api/logs` — Log a food item consumed
- **GET** `/api/logs?date=<date>` — Retrieve logs for a specific date
- **DELETE** `/api/logs/{id}` — Delete a log entry

### Dashboard
- **GET** `/api/dashboard/daily?date=<date>` — Get daily calorie and macro totals

For the complete technical specification, see [SPEC.md](./SPEC.md).

---

## Database Schema

Three main tables power Lume:

**users** — Stores user accounts and calorie goals
**food_items** — Local cache of USDA food data
**food_logs** — User's daily food consumption logs

See [SPEC.md](./SPEC.md) for detailed schema definitions.

---

## Development Status

| Phase | Status | What |
|-------|--------|------|
| 1 | ✅ | Backend setup, database connection |
| 2 | 🔄 | Auth routes (register, login) |
| 3 | 🔄 | USDA API integration |
| 4 | 🔄 | Food log CRUD |
| 5 | ⏳ | Dashboard aggregation |
| 6 | ⏳ | Frontend scaffolding |
| 7 | ⏳ | Auth screens |
| 8 | ⏳ | Search UI |
| 9 | ⏳ | Food logging UI |
| 10 | ⏳ | Dashboard UI |

---

## Contributing

This is an early-stage project. Check the [SPEC.md](./SPEC.md) for planned features and the issue tracker for known tasks.

---

## License

Not yet specified. This project is a work in progress.

---

## Notes

- **No production deployment yet.** This is a learning/development project.
- The SPEC.md file contains detailed technical designs and implementation order.
- All nutrition data comes from the free USDA FoodData Central API (no API key required).

For questions or suggestions, open an issue.
