-- Migration: add serving metadata and base nutrition columns to food_logs
--
-- Run once in the Supabase SQL editor (or via psql) before deploying the
-- updated backend.  All statements use IF NOT EXISTS so they are safe to
-- re-run if you are unsure whether the migration has already been applied.
--
-- Existing rows are unaffected — all columns default to NULL.
-- Old rows continue to work: the backend and frontend both check for NULL
-- before attempting serving-based recalculation.

-- Serving context: how many servings the user chose, what unit, and grams
-- per serving (useful for future weight-based scaling).
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS serving_quantity DOUBLE PRECISION;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS serving_unit     VARCHAR;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS serving_grams    DOUBLE PRECISION;

-- Immutable per-1-serving base nutrition values.
-- These are written once at log-creation time and never changed, so that
-- future serving-quantity edits can always recompute accurate macros.
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS base_calories DOUBLE PRECISION;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS base_protein  DOUBLE PRECISION;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS base_carbs    DOUBLE PRECISION;
ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS base_fat      DOUBLE PRECISION;
