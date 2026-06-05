# Prompt: Multi-Agent Read-Only QA

Use this prompt when you want Claw to coordinate focused QA agents without changing code.

```text
Run read-only multi-agent QA for Lume.

Scope:
<feature, bug report, phase, branch, commit, or release candidate>

Use:
- docs/qa/lume-multi-agent-qa.md
- docs/qa/templates/qa-report-template.md
- relevant docs/qa/checklists/*.md

Rules:
- Start with git status.
- Do not edit files.
- Do not change production, Supabase, Render, Vercel, or env vars.
- Do not print secrets.
- Do not run destructive commands.
- Use only the focused agents needed for this scope.
- Preserve existing user and Claude work.
- Consolidate duplicate findings into one QA report.

Preferred agent split:
- Auth And Session QA Agent, if auth/session is in scope.
- Food Logging QA Agent, if food search/logging/totals are in scope.
- Profile, Weight, And Goals QA Agent, if profile/weight/goal/prediction is in scope.
- Backend API QA Agent, if backend routes/models/schema are in scope.
- Frontend UX QA Agent, if UI flows or app behavior are in scope.
- Privacy And Security QA Agent, if data exposure, auth boundaries, logs, or deployment safety are in scope.

Final output:
- Use the QA report template.
- Include a safe-to-keep or not-safe-to-ship verdict.
- Include exact reproduction steps for every real bug.
- Include recommended next phase.
```

