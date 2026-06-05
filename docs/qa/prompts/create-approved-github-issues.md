# Prompt: Create Approved GitHub Issues

Use this prompt only after Shri explicitly approves specific issue drafts.

```text
Create the approved GitHub issues for Lume.

Approved issues:
<list exact approved issue titles or draft sections>

Rules:
- Create only the approved issues.
- Do not create speculative or unapproved issues.
- Do not push code.
- Do not open PRs.
- Do not change labels or milestones unless needed for the approved issues.
- Do not include secrets, raw env values, tokens, database URLs, or personal health data.
- Return the created issue links.

Before creating:
- Confirm repo target.
- Confirm issue titles.
- Confirm labels.
```

