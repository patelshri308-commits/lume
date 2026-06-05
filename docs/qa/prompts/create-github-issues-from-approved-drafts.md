# Prompt: Create GitHub Issues From Approved Drafts

Use this prompt only after Shri has selected specific local issue drafts.

```text
Create GitHub issues from the approved local drafts.

Approved draft files:
<list exact files under docs/qa/github/issue-drafts/>

Repository:
<owner/repo>

Rules:
- Create only the listed drafts.
- Do not create drafts with approved_for_github: false unless Shri explicitly selected them in this message.
- Do not create speculative or unapproved issues.
- Do not push code.
- Do not open PRs.
- Do not include secrets, raw env values, tokens, database URLs, or personal health data.
- Return the created issue links.
- After creation, update the local draft metadata only if explicitly asked.

Before creating:
- Confirm repo target.
- Confirm issue titles.
- Confirm labels.
```

