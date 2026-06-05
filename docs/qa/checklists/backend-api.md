# Backend API QA Checklist

## Scope

Use this checklist when changes touch FastAPI routes, Pydantic models, SQLAlchemy models, migrations, services, Supabase assumptions, auth dependencies, or response contracts consumed by the frontend.

## Inspect

- Changed routes have clear request and response shapes.
- Pydantic models match frontend payloads.
- SQLAlchemy models match expected database columns.
- Migrations exist for new or changed database columns.
- Auth-required routes use the auth dependency.
- Errors use appropriate status codes and actionable messages.
- Service failures do not leak secrets or raw credentials.
- Tests cover the changed route, model, or service behavior.
- Local code does not assume unapplied production schema changes are already present.

## Common Failure Modes

- Route accepts a field but does not persist it.
- Route response shape changes without frontend updates.
- SQLAlchemy model gets ahead of Supabase schema.
- Test fixtures pass but real database calls fail.
- Route trusts client-provided user IDs instead of authenticated user identity.
- Backend returns 500 for user-correctable errors.
- Debug logs include sensitive request headers or tokens.

## Evidence Required

For each finding, include:

- endpoint and method
- request shape
- response status and redacted response body, if available
- expected behavior
- actual behavior
- model/schema files involved
- migration status or migration file, if relevant

## Suggested Local Checks

```bash
git status --short --branch
cd backend && pytest tests -q
```

For route-specific changes, prefer the narrowest relevant test first.

Do not inspect or print `.env` values. Report only variable names or missing configuration.

