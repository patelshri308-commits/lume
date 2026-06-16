-- Migration 001: create food_logs table (baseline schema)
--
-- Run once before any additive migrations (002+).
-- Safe to re-run — uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS food_logs (
    id         SERIAL PRIMARY KEY,
    user_id    VARCHAR        NOT NULL,
    name       VARCHAR        NOT NULL,
    calories   DOUBLE PRECISION NOT NULL,
    protein    DOUBLE PRECISION NOT NULL,
    carbs      DOUBLE PRECISION NOT NULL,
    fat        DOUBLE PRECISION NOT NULL,
    log_date   DATE           NOT NULL,
    created_at TIMESTAMP      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_food_logs_user_id ON food_logs (user_id);
