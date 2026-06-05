# Prompt: Draft GitHub Issues From QA Findings

Use this prompt after a QA report when you want Claw to turn confirmed findings into GitHub-ready issue drafts in the response. For the preferred semi-automatic workflow, use `docs/qa/prompts/create-local-github-issue-drafts.md` instead so drafts are saved under `docs/qa/github/issue-drafts/`.

```text
Draft GitHub issue bodies from this Lume QA report.

QA report:
<paste report or point to report file>

Use:
- docs/qa/github/github-issue-workflow.md
- docs/qa/templates/github-issue-draft-template.md
- docs/qa/templates/qa-report-template.md

Rules:
- Do not create GitHub issues yet.
- Do not push, merge, or open PRs.
- Prefer local draft files when the user wants a selectable queue.
- Do not include secrets, raw env values, tokens, database URLs, or personal health data.
- Only draft issues for confirmed findings.
- Keep uncertain findings in an "investigation candidates" section.
- Consolidate duplicate findings.
- Add recommended labels and severity.

Final output:
- Issue-ready drafts
- Investigation candidates
- Items not worth filing
- Explicit approval question before any GitHub action
```
