-- Migration: add nutrition-source metadata columns to food_logs
--
-- Run this once in the Supabase SQL editor (or via psql) before deploying
-- the updated backend.  All four statements use IF NOT EXISTS so they are
-- safe to re-run if you are unsure whether the migration has already run.
--
-- Existing rows are unaffected: the columns default to NULL, which the
-- updated backend treats as "no source information available".

ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS source_type         VARCHAR;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS confidence          DOUBLE PRECISION;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS is_estimated        BOOLEAN;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS serving_description VARCHAR;
