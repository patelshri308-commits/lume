# Auth And Session QA Checklist

## Scope

Use this checklist when changes touch login, signup, logout, password reset, Supabase session handling, protected backend routes, or frontend auth state.

## Inspect

- Signup flow creates a session or gives a clear confirmation state.
- Login succeeds with valid credentials and fails cleanly with invalid credentials.
- Logout clears frontend session state and prevents protected API calls.
- Password reset sends users to the intended reset route.
- Password recovery deep links restore the Supabase session correctly.
- Access tokens are attached to protected backend requests.
- Backend routes reject missing, expired, or invalid bearer tokens.
- Frontend handles expired sessions without trapping users in broken loading states.

## Common Failure Modes

- Frontend has a session but API calls miss the `Authorization` header.
- Password recovery URL opens but Supabase never receives the recovery tokens.
- Protected data loads for the wrong user.
- Logout clears UI state but leaves stored session data behind.
- Backend returns a generic 500 for auth failures instead of 401/403.
- Reset links point to production when testing local flows.

## Evidence Required

For each finding, include:

- user state: logged out, logged in, expired session, or recovery session
- route or screen involved
- API endpoint involved, if any
- expected behavior
- actual behavior
- relevant file paths
- safe reproduction steps

## Suggested Local Checks

```bash
git status --short --branch
```

Optional, depending on scope:

```bash
cd backend && pytest tests -q
```

Do not print access tokens, refresh tokens, Supabase keys, or `.env` values.

