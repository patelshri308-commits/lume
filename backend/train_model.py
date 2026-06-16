"""
Weight change prediction model — bootstrap training script.

Uses the Kaggle health/lifestyle dataset as a stand-in until real Lume user
data is available. When you have real data, replace the CSV loading block
with your user export and retrain — the feature schema and model class stay
the same.

Usage:
    cd backend
    python train_model.py                          # uses default CSV path
    python train_model.py --csv path/to/data.csv  # custom path

Output:
    app/services/weight_change_model.pkl
"""
from __future__ import annotations

import argparse
import pickle
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, r2_score

# ── Constants (must match prediction_service.py) ──────────────────────────────

KCAL_PER_KG = 7700

ACTIVITY_MULTIPLIERS = {
    0: 1.2,    # sedentary
    1: 1.375,  # light
    2: 1.55,   # moderate
    3: 1.725,  # active
    4: 1.9,    # very_active
}

MODEL_OUT = Path(__file__).parent / "app" / "services" / "weight_change_model.pkl"

# ── Feature schema ─────────────────────────────────────────────────────────────
#
# These six features are what Lume can provide at inference time from the user
# profile + food logs. Keep this list in sync with prediction_service.py.
#
FEATURE_COLS = ["age", "sex", "height_cm", "weight_kg", "avg_daily_calories", "activity_level"]


# ── Helpers ───────────────────────────────────────────────────────────────────

def mifflin_bmr(weight_kg: float, height_cm: float, age: float, sex: int) -> float:
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    return base + 5 if sex == 1 else base - 161


def exercise_hours_to_activity_level(hours: float) -> int:
    if hours < 1:
        return 0
    if hours < 3:
        return 1
    if hours < 5:
        return 2
    if hours < 7:
        return 3
    return 4


# ── Load & engineer Kaggle data ───────────────────────────────────────────────

def load_kaggle(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    out = pd.DataFrame()
    out["age"]                = df["Age"].astype(float)
    out["sex"]                = (df["Gender"].str.lower() == "male").astype(int)
    out["height_cm"]          = df["Height_cm"].astype(float)
    out["weight_kg"]          = df["Weight_kg"].astype(float)
    out["avg_daily_calories"] = df["Calories_Intake"].astype(float)
    out["activity_level"]     = df["Exercise_Hours_per_Week"].apply(exercise_hours_to_activity_level)

    return out


def synthesize_target(df: pd.DataFrame, rng: np.random.Generator) -> pd.Series:
    """
    Derive weight_change_30d_kg from each person's caloric balance vs their
    TDEE. We use their actual calorie intake as avg_daily_calories, so the
    balance = calories - TDEE.

    Gaussian noise (std=0.4 kg) is added to simulate real-world metabolic
    variation. When retraining on actual Lume user data, replace this with
    the measured 30-day weight delta — no other changes needed.
    """
    bmr = df.apply(
        lambda r: mifflin_bmr(r["weight_kg"], r["height_cm"], r["age"], r["sex"]),
        axis=1,
    )
    multiplier = df["activity_level"].map(ACTIVITY_MULTIPLIERS)
    tdee = bmr * multiplier
    daily_balance = df["avg_daily_calories"] - tdee
    change_30d = (daily_balance * 30) / KCAL_PER_KG
    noise = rng.normal(0, 0.4, size=len(df))
    return change_30d + noise


# ── Train ─────────────────────────────────────────────────────────────────────

def train(csv_path: str) -> None:
    rng = np.random.default_rng(42)

    print(f"Loading data from {csv_path} ...")
    df = load_kaggle(csv_path)
    y  = synthesize_target(df, rng)
    X  = df[FEATURE_COLS]

    # Drop any rows with nulls
    mask = X.notna().all(axis=1) & y.notna()
    X, y = X[mask], y[mask]
    print(f"  {len(X)} usable rows after null filter")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    )

    model = GradientBoostingRegressor(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        random_state=42,
    )
    model.fit(X_train.values, y_train.values)

    preds = model.predict(X_test.values)
    mae   = mean_absolute_error(y_test, preds)
    r2    = r2_score(y_test, preds)
    print(f"  Test MAE : {mae:.3f} kg  |  R²: {r2:.3f}")

    feature_importance = dict(zip(FEATURE_COLS, model.feature_importances_))
    print("  Feature importances:")
    for feat, imp in sorted(feature_importance.items(), key=lambda x: -x[1]):
        print(f"    {feat:<22} {imp:.3f}")

    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(MODEL_OUT, "wb") as f:
        pickle.dump({"model": model, "features": FEATURE_COLS}, f)
    print(f"\nModel saved → {MODEL_OUT}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--csv",
        default=str(Path(__file__).parent.parent / "health_activity_data.csv"),
        help="Path to training CSV",
    )
    args = parser.parse_args()

    if not Path(args.csv).exists():
        print(f"ERROR: CSV not found at {args.csv}", file=sys.stderr)
        sys.exit(1)

    train(args.csv)
