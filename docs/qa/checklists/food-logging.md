# Food Logging QA Checklist

## Scope

Use this checklist when changes touch food search, food selection, serving sizes, quantity scaling, daily food logs, calorie/macros totals, USDA matching, or food-engine source quality.

## Inspect

- Search returns reasonable results for common generic foods.
- Serving descriptions match calculated grams and displayed calories.
- Quantity scaling works for whole numbers, decimals, cups, tablespoons, grams, and size modifiers.
- Add-log payload matches backend route expectations.
- Logged entries appear in the correct day.
- Daily totals update after add, edit, or delete.
- Backend does not silently fall back to vague estimates when a better source exists.
- Food-engine changes preserve known benchmark wins.
- Error messages distinguish search failure, log failure, auth failure, and schema/backend failure where possible.

## Common Failure Modes

- Frontend sends a field the backend does not accept.
- Backend expects a database column that is not present in Supabase.
- Source selection picks an adjacent food, brand, preparation, or substitute.
- Quantity scaling is correct in search preview but wrong in the saved log.
- Daily entries load but totals do not recalculate.
- A failed backend response becomes only "failed to log food" in the UI.
- Live USDA results differ from unit-test fixtures.

## Evidence Required

For each finding, include:

- query or food item
- serving and quantity used
- selected source name and source type, if available
- displayed calories/macros
- saved entry calories/macros
- endpoint and response status, if available
- expected behavior
- actual behavior
- relevant file paths

## Suggested Local Checks

```bash
git status --short --branch
cd backend && pytest tests/test_nutrition_unit.py -q
```

Optional live check when explicitly appropriate:

```bash
cd backend && python3 scripts/audit_generic_foods.py
```

Do not run broad live benchmarks unless the requested QA scope needs them.

