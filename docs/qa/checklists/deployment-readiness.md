# Deployment Readiness QA Checklist

## Scope

Use this checklist before deploying or merging meaningful changes to production-facing branches, especially when changes touch backend routes, migrations, auth, environment variables, frontend API URLs, Render, Vercel, Supabase, or user data flows.

## Inspect

- Git branch is in the expected state.
- Changed files are intentional.
- No unrelated local work is mixed into the deployment.
- Backend tests relevant to the change pass.
- Frontend checks relevant to the change pass, if available.
- Required migrations are identified and reviewed.
- Production schema changes have explicit approval.
- Render, Vercel, Supabase, and env var changes are explicitly approved.
- Frontend points at the intended backend for the target environment.
- Rollback plan is clear.
- Known limitations are documented.

## Common Failure Modes

- Code deploys before the required Supabase migration.
- Local `.env` works but production env vars are missing.
- Frontend deploy points to the wrong backend URL.
- A documentation-only commit is mixed with app behavior changes.
- A fix is safe locally but breaks production auth/session redirects.
- No rollback path exists for schema-dependent changes.

## Evidence Required

For each deployment risk, include:

- changed file or setting
- environment affected
- required approval, if any
- expected deployment order
- rollback consideration
- test or check that supports readiness

## Suggested Local Checks

```bash
git status --short --branch
git diff --stat
```

Backend-focused deployment:

```bash
cd backend && pytest tests -q
```

Food-engine deployment:

```bash
cd backend && pytest tests/test_nutrition_unit.py -q
cd backend && python3 scripts/audit_generic_foods.py
```

Do not change deployment settings, production env vars, or production Supabase schema/data unless Shri explicitly approves the specific change.

