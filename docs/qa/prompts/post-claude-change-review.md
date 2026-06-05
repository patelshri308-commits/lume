# Prompt: Post-Claude Change Review

Use this prompt after Claude implements a bounded feature or fix and Shri wants Claw to verify it.

```text
Review Claude's latest Lume changes as QA Lead.

Scope:
<feature, bug fix, phase, or files Claude changed>

Claude summary:
<paste Claude's summary, changed files, tests run, and known issues>

Use:
- docs/qa/lume-multi-agent-qa.md
- docs/qa/templates/qa-report-template.md
- relevant docs/qa/checklists/*.md

Rules:
- Start with git status.
- Inspect the diff before running tests.
- Do not edit files unless I explicitly ask for fixes.
- Do not change production, Supabase, Render, Vercel, or env vars.
- Do not print secrets.
- Preserve unrelated local changes.
- Verify Claude's stated tests/results when practical.
- Look for unintended side effects outside Claude's stated scope.

Review steps:
1. Run git status.
2. Identify changed files.
3. Inspect diffs for behavior, schema, auth, privacy, and frontend/backend contract risks.
4. Use focused agents only if the changed scope spans independent areas.
5. Run focused local tests/checks that match the change.
6. Compare results to acceptance criteria.
7. Report what improved, what broke, what remains risky, and whether the change is safe to keep.

Final output:
- Verdict: safe to keep / needs follow-up / not safe to ship.
- Changed files reviewed.
- Tests/checks run and outcomes.
- Findings by severity.
- Any mismatch between Claude's summary and actual code.
- Recommended next phase.
```

