# Lume Multi-Agent QA Workflow

## Purpose

Use Claw as the Lume QA Lead to coordinate focused multi-agent reviews after meaningful app changes. This workflow is for finding bugs, regressions, safety risks, schema mismatches, and incomplete implementation work before changes are deployed or handed back for fixes.

The default mode is read-only QA. Agents inspect, test, and report. They do not edit files unless Shri explicitly asks for fixes.

## Operating Rules

- Start every QA run with `git status --short --branch`.
- Preserve existing user or Claude work. Do not revert unrelated changes.
- Do not change production settings.
- Do not change Render, Vercel, Supabase, production env vars, or production schema without explicit approval.
- Do not print secrets from `.env` files or logs.
- Do not run destructive commands.
- Do not expand scope beyond the requested feature or phase.
- Prefer focused local tests and smoke checks over broad, slow test runs unless the requested scope needs them.
- Report findings before recommending implementation work.
- Keep findings evidence-based: include reproduction steps, expected behavior, actual behavior, likely files, and severity.

## When To Use This Workflow

Use multi-agent QA when a change touches one or more user-facing flows, backend contracts, database assumptions, auth, privacy, deployment readiness, or important Lume product behavior.

Good trigger examples:

- New food logging behavior
- New profile, weight, hydration, or prediction feature
- Backend route or schema changes
- Auth/session changes
- Pre-deployment review
- Post-Claude implementation review
- Bug reports that could involve both frontend and backend

Avoid multi-agent QA for tiny one-line documentation changes, unless the user specifically asks for a formal review.

## Standard Agent Roles

### Auth And Session QA Agent

Scope:

- sign up
- sign in
- sign out
- password reset
- password recovery deep links
- token refresh
- protected API calls
- unauthorized states

Common failure modes:

- stale session state
- missing auth header
- incorrect Supabase redirect URL
- logged-out user can reach protected data
- password recovery opens but does not update session

### Food Logging QA Agent

Scope:

- food search
- generic food source selection
- serving size selection
- quantity scaling
- add log
- load daily entries
- edit/delete logs
- daily nutrition totals

Common failure modes:

- frontend payload does not match backend model
- backend assumes missing Supabase columns
- serving description does not match calculated grams
- stale daily totals after add/delete
- API failure shown as generic "failed to log food"

### Profile, Weight, And Goals QA Agent

Scope:

- profile save/load
- current weight
- goal weight
- weight history
- prediction behavior
- onboarding/profile completion state
- daily summary integration

Common failure modes:

- frontend sends a new field not present in backend model or database
- backend accepts a field but does not persist it
- prediction output silently fails when history is sparse
- weight units or rounding are inconsistent

### Backend API QA Agent

Scope:

- FastAPI routes
- Pydantic request/response models
- SQLAlchemy models
- migrations
- Supabase schema assumptions
- route-level auth checks
- error handling

Common failure modes:

- local model is ahead of production schema
- migration exists but has not been applied
- route returns 500 instead of actionable 4xx
- response shape changed without frontend updates
- tests use mocked paths that miss production errors

### Frontend UX QA Agent

Scope:

- primary app flows
- loading states
- empty states
- error banners
- disabled buttons
- mobile layout
- navigation after success/failure

Common failure modes:

- user sees a vague error with no recovery path
- form submits while invalid or already loading
- successful API call does not update local state
- keyboard or mobile layout blocks important controls
- feature works only after a refresh

### Privacy And Security QA Agent

Scope:

- tracked secrets
- ignored local secrets
- unsafe logs
- public/private route boundaries
- client-side exposure
- personal data files
- auth bypass risks

Common failure modes:

- `.env` values committed
- personal CSV/database files tracked
- service role keys exposed to frontend
- logs print bearer tokens or user data
- backend route trusts a client-provided user id

## QA Lead Workflow

1. Confirm scope.
2. Run `git status --short --branch`.
3. Identify changed files and likely affected features.
4. Decide which agent roles are needed.
5. Spawn only the agents needed for the scope.
6. Give each agent a bounded read-only task.
7. Continue local review while agents inspect independent areas.
8. Consolidate duplicate findings.
9. Rank findings by severity.
10. Produce one final QA report.

## Severity Levels

- Blocker: prevents core use, causes data loss, breaks auth, exposes secrets, or blocks deployment.
- High: serious regression in an important workflow, backend/frontend contract mismatch, or likely production failure.
- Medium: real bug with a workaround or limited scope.
- Low: polish issue, unclear UX, minor inconsistency, or documentation gap.

## Required Finding Format

Each finding should include:

- Severity
- Title
- Evidence
- Reproduction steps
- Expected behavior
- Actual behavior
- Likely files involved
- Recommended next action

## Final Report Format

Use this structure for the consolidated report:

```markdown
# Lume QA Report: <scope>

## Verdict
Safe to keep / Not safe to ship / Needs follow-up before deployment

## Git State
<branch, ahead/behind, modified files>

## Agents Used
<agent roles and scope>

## Blockers
<findings>

## High Priority
<findings>

## Medium Priority
<findings>

## Low Priority
<findings>

## Tests Or Checks Run
<commands and outcomes>

## Regression Risks
<what could still be missed>

## Recommended Next Phase
<smallest safe next step>
```

## Standard Prompt

Use this prompt shape to start a run:

```text
Run read-only multi-agent QA for Lume.

Scope:
<feature, bug, or release>

Rules:
- Start with git status.
- Do not edit files.
- Do not change production, Supabase, Render, Vercel, or env vars.
- Do not print secrets.
- Use focused agents only.
- Consolidate findings into one QA report.
```

