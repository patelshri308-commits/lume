-- Migration 002: create user_profiles table (baseline schema)
--
-- Run once before any additive migrations (003+).
-- Safe to re-run — uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS user_profiles (
    user_id              VARCHAR PRIMARY KEY,
    display_name         VARCHAR,
    sex                  VARCHAR,
    age                  INTEGER,
    height_cm            NUMERIC,
    weight_kg            NUMERIC,
    goal_weight_kg       NUMERIC,
    goal_type            VARCHAR        NOT NULL DEFAULT 'maintain',
    activity_level       VARCHAR        NOT NULL DEFAULT 'moderate',
    onboarding_completed BOOLEAN        NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
