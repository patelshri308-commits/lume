-- Migration 000: create weight_logs table (baseline schema)
--
-- This table is created and owned by Supabase. This file documents the
-- expected schema so migration history is complete and explicit.
-- Safe to re-run — uses IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS weight_logs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    VARCHAR                  NOT NULL,
    log_date   DATE                     NOT NULL,
    weight_kg  NUMERIC                  NOT NULL,
    note       VARCHAR,
    created_at TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, log_date)
);

CREATE INDEX IF NOT EXISTS ix_weight_logs_user_id ON weight_logs (user_id);
