# Privacy And Security QA Checklist

## Scope

Use this checklist when changes touch auth, profile/health data, logs, environment variables, database access, public routes, deployment settings, personal data files, or third-party integrations.

## Inspect

- No tracked `.env`, database, CSV, private key, or credential files.
- Frontend exposes only public-safe variables.
- Backend secrets stay server-side.
- Logs do not print bearer tokens, refresh tokens, database URLs, or personal health data.
- Protected routes require authenticated users.
- Backend uses authenticated user identity rather than trusting client-provided IDs.
- Personal health data files are ignored and not tracked.
- Vendor/API configuration is documented without revealing secrets.
- Error messages do not leak stack traces or credentials in user-facing flows.

## Common Failure Modes

- Supabase service role key appears in frontend code.
- Database URL or API key is committed.
- Personal CSV exports are tracked.
- Debug logging prints full request headers.
- Public reset or auth routes expose too much data.
- A route returns another user's logs or profile data.
- `.env.example` accidentally contains real values instead of placeholders.

## Evidence Required

For each finding, include:

- file path and line number where safe
- type of exposure without printing the secret value
- whether the file is tracked or ignored
- expected privacy boundary
- actual behavior
- recommended remediation

## Suggested Local Checks

```bash
git status --short --branch
git ls-files
git status --short --ignored
```

Use redacted scans only. Do not print secret values.

Useful pattern categories:

- `DATABASE_URL`
- `DIRECT_URL`
- `SUPABASE_*`
- `*_SECRET`
- `*_TOKEN`
- `*_API_KEY`
- private key blocks
- JWT-looking values
- personal `.csv` or `.db` files

