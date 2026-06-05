# Prompt: Deployment Readiness Review

Use this prompt before pushing, merging, or deploying Lume changes.

```text
Run a Lume deployment readiness review.

Target:
<branch, commit, PR, release, or local changes>

Use:
- docs/qa/lume-multi-agent-qa.md
- docs/qa/templates/qa-report-template.md
- docs/qa/checklists/deployment-readiness.md
- docs/qa/checklists/privacy-security.md
- any feature checklist relevant to the changed files

Rules:
- Start with git status.
- Do not edit files unless I explicitly ask.
- Do not push, merge, deploy, or change production.
- Do not change Supabase, Render, Vercel, or env vars without explicit approval.
- Do not print secrets.
- Identify whether migrations or production env changes are required.
- Verify no unrelated changes are mixed in.

Review steps:
1. Run git status and inspect ahead/behind state.
2. Review changed files and diff stat.
3. Identify production-impacting changes.
4. Check for migrations and schema assumptions.
5. Check for env/config/deployment changes.
6. Run focused tests/checks appropriate to the change.
7. Run privacy/security scan if deployment includes user data, auth, logs, or config changes.
8. Produce a deployment verdict and rollback considerations.

Final output:
- Deployment verdict: ready / not ready / ready after approval.
- Required approvals.
- Tests/checks run.
- Migration requirements.
- Env/config requirements.
- Privacy/security findings.
- Rollback notes.
- Recommended deployment order.
```

