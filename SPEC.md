# Lume — MVP Technical Spec

---

## App Purpose
Lume is a mobile calorie tracker. Users search for food by typing naturally, log what they eat, and see their daily calorie and macro totals. Nothing more in v1.

## Target User
Solo individual who wants to track daily food intake without complexity. No fitness background assumed.

---

## MVP Scope

**In v1:**
- Email/password authentication
- Natural language food search powered by the USDA FoodData Central API
- Log a food item with a serving count and meal type
- Delete a logged item
- View daily calorie and macro totals (calories, protein, carbs, fat)
- Set a personal daily calorie goal (stored on the user record)

**Explicitly out of v1:**
- Branded/restaurant-specific scraping
- LLM query classification or AI insights
- Refresh tokens
- Meals as a separate entity
- Weekly trends or charts
- Soft deletes
- Barcode scanning
- Account deletion flow
- Multiple nutrition data providers

---

## Locked Tech Stack

| Layer       | Choice                         |
|-------------|--------------------------------|
| Frontend    | React Native + Expo (Expo Router) |
| Backend     | FastAPI (Python)               |
| Database    | Supabase (hosted PostgreSQL)   |
| Auth        | JWT — `python-jose` + `bcrypt` |
| Nutrition   | USDA FoodData Central API (free, no billing) |
| State       | Zustand (auth token + user)    |
| Server state| React Query                    |
| HTTP client | Axios                          |

---

## MVP API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/auth/register` | Create account, return JWT |
| POST | `/api/auth/login` | Verify credentials, return JWT |
| GET  | `/api/food/search?q=` | Query USDA, return top results |
| POST | `/api/logs` | Log a food item |
| GET  | `/api/logs?date=` | Fetch all logs for a date |
| DELETE | `/api/logs/{id}` | Delete a log entry |
| GET  | `/api/dashboard/daily?date=` | Calorie + macro totals for a date |

**Key shapes:**

```
POST /api/auth/register
  req:  { email, password, username }
  res:  { access_token, user_id, username }

GET /api/food/search?q=banana
  res:  { results: [{ usda_fdc_id, name, calories, protein_g,
                      carbs_g, fat_g, serving_size, serving_unit }] }

POST /api/logs
  req:  { usda_fdc_id, name, calories, protein_g, carbs_g, fat_g,
          serving_size, serving_unit, servings, meal_type, log_date }
  res:  { log_id, ...all fields }

GET /api/dashboard/daily?date=2026-04-10
  res:  { date, calorie_goal, calories_consumed, protein_g,
          carbs_g, fat_g, logs: [...] }
```

> Nutrition values are passed from the client on log creation — no second lookup needed.
> Consumed macros are stored denormalized (`servings × macro`) so daily totals are a single `SUM()` query.

---

## MVP Data Models

**3 tables.**

```sql
users
  id             UUID  PK  DEFAULT gen_random_uuid()
  email          TEXT  UNIQUE NOT NULL
  username       TEXT  NOT NULL
  password_hash  TEXT  NOT NULL
  calorie_goal   INT   DEFAULT 2000
  created_at     TIMESTAMPTZ DEFAULT NOW()

food_items                         -- local USDA cache
  id             UUID  PK  DEFAULT gen_random_uuid()
  usda_fdc_id    TEXT  UNIQUE NOT NULL
  name           TEXT  NOT NULL
  calories       FLOAT NOT NULL
  protein_g      FLOAT NOT NULL
  carbs_g        FLOAT NOT NULL
  fat_g          FLOAT NOT NULL
  serving_size   FLOAT NOT NULL
  serving_unit   TEXT  NOT NULL
  created_at     TIMESTAMPTZ DEFAULT NOW()

food_logs
  id                   UUID  PK  DEFAULT gen_random_uuid()
  user_id              UUID  NOT NULL  -- FK → users.id ON DELETE CASCADE
  food_item_id         UUID  NOT NULL  -- FK → food_items.id
  name                 TEXT  NOT NULL  -- denormalized for display
  meal_type            TEXT  NOT NULL  -- breakfast | lunch | dinner | snack
  log_date             DATE  NOT NULL
  servings             FLOAT NOT NULL
  calories_consumed    FLOAT NOT NULL  -- servings × calories
  protein_consumed_g   FLOAT NOT NULL
  carbs_consumed_g     FLOAT NOT NULL
  fat_consumed_g       FLOAT NOT NULL
  created_at           TIMESTAMPTZ DEFAULT NOW()

  INDEX (user_id, log_date)
```

---

## Folder Structure

```
lume/
├── frontend/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── _layout.tsx
│   │   │   ├── login.tsx
│   │   │   └── register.tsx
│   │   ├── (tabs)/
│   │   │   ├── _layout.tsx
│   │   │   ├── index.tsx        # Dashboard
│   │   │   └── search.tsx       # Food search + log
│   │   └── _layout.tsx          # Root layout, auth guard
│   ├── components/
│   │   ├── FoodSearchBar.tsx
│   │   ├── FoodResultCard.tsx
│   │   ├── LogItem.tsx
│   │   └── MacroSummary.tsx
│   ├── api/
│   │   └── client.ts            # Axios instance + all API functions
│   ├── store/
│   │   └── authStore.ts         # Zustand: token + user identity
│   ├── app.json
│   ├── tsconfig.json
│   └── package.json
│
├── backend/
│   ├── app/
│   │   ├── main.py              # App factory, CORS, router registration
│   │   ├── config.py            # Env vars via pydantic-settings
│   │   ├── database.py          # SQLAlchemy async engine + session
│   │   ├── models.py            # All 3 ORM models
│   │   ├── schemas.py           # All Pydantic request/response schemas
│   │   ├── auth.py              # JWT creation, password hashing, get_current_user
│   │   └── routers/
│   │       ├── auth.py          # /auth/register, /auth/login
│   │       ├── food.py          # /food/search
│   │       ├── logs.py          # /logs CRUD
│   │       └── dashboard.py     # /dashboard/daily
│   ├── requirements.txt
│   └── .env.example
│
└── SPEC.md
```

---

## Simplified Data Flow

```
FOOD SEARCH
  User types → GET /food/search?q=chicken
  → router hits USDA API → parse top results
  → return [{ name, calories, macros, serving }]
  → frontend renders result cards

LOG FOOD
  User picks result + sets servings + meal type → POST /logs
  → backend: upsert food_item by usda_fdc_id
  → calculate consumed = servings × each macro
  → insert food_log row
  → frontend: refetch dashboard

DASHBOARD
  Screen loads → GET /dashboard/daily?date=today
  → SELECT SUM(calories_consumed), SUM(protein...), SUM(carbs...), SUM(fat...)
    FROM food_logs WHERE user_id = ? AND log_date = ?
  → fetch user.calorie_goal → compute remaining
  → return totals + log list

AUTH
  Register: hash password → insert user → return JWT
  Login: lookup by email → verify hash → return JWT
  Protected routes: decode JWT from Authorization header → extract user_id
```

---

## Implementation Order

| Phase | What to build | Deliverable |
|-------|--------------|-------------|
| 1 | FastAPI project setup, Supabase connection, 3 DB tables | Backend boots, tables exist |
| 2 | Auth routes (register + login) + JWT | Can create account and get a token |
| 3 | USDA API integration in `/food/search` | Real nutrition data returns from a query |
| 4 | `POST /logs`, `GET /logs`, `DELETE /logs/{id}` | Can log and retrieve food entries |
| 5 | `GET /dashboard/daily` | Aggregated daily totals return correctly |
| 6 | Expo project scaffold, Zustand auth store | App boots, auth state persists |
| 7 | Login + register screens wired to backend | Can sign in on device |
| 8 | Search tab: `FoodSearchBar` + `FoodResultCard` list | Can search and see results |
| 9 | Serving selector + meal type picker → `POST /logs` | Can log food from the app |
| 10 | Dashboard tab: `MacroSummary` + log list + delete | Full working MVP |

---

*This spec covers v1 only. Do not add to it without intentionally scoping a v2.*
