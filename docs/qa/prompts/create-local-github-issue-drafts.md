# Prompt: Create Local GitHub Issue Drafts

Use this prompt after a QA report when you want local issue files first, before any GitHub action.

```text
Create local GitHub issue drafts from this Lume QA report.

QA report:
<paste report or point to report file>

Use:
- docs/qa/github/github-issue-workflow.md
- docs/qa/templates/github-issue-draft-template.md

Rules:
- Do not create live GitHub issues.
- Do not push, merge, or open PRs.
- Write drafts under docs/qa/github/issue-drafts/.
- Only draft confirmed findings with evidence.
- Keep uncertain findings out of the draft folder.
- Do not include secrets, raw env values, tokens, database URLs, or personal health data.
- Set approved_for_github: false on every draft.
- Set created_on_github: false on every draft.

Final output:
- List local draft files created.
- List findings not drafted and why.
- Ask which draft numbers should be approved for GitHub creation.
```

