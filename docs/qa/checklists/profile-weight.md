# Profile, Weight, And Goals QA Checklist

## Scope

Use this checklist when changes touch user profile fields, onboarding, current weight, goal weight, weight history, predictions, hydration/weight widgets, or daily summaries.

## Inspect

- Profile fields save and reload correctly.
- New profile fields exist in frontend state, backend request models, SQLAlchemy models, and database migrations where needed.
- Weight values have consistent units and rounding.
- Goal weight is optional where appropriate and validated where required.
- Prediction behavior is sensible with no data, sparse data, and enough history.
- Daily summaries do not break when weight or goal data is missing.
- UI handles loading, empty history, and failed save states.
- Backend responses do not expose another user's profile or weight data.

## Common Failure Modes

- Frontend sends a new field that backend ignores.
- Backend model includes a column that Supabase does not have.
- Migration exists locally but was not applied to production.
- Empty or sparse history causes prediction crashes.
- Weight units silently mix pounds and kilograms.
- Goal fields save locally but disappear after refresh.
- A profile save failure leaves the UI looking successful.

## Evidence Required

For each finding, include:

- user/profile state before the test
- field values entered
- endpoint and response status, if applicable
- database/schema assumption, if applicable
- expected behavior
- actual behavior
- relevant file paths

## Suggested Local Checks

```bash
git status --short --branch
cd backend && pytest tests/test_prediction.py -q
```

If backend profile contracts changed:

```bash
cd backend && pytest tests -q
```

Do not apply Supabase migrations without explicit approval.

