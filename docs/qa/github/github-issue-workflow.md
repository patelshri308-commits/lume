# Lume GitHub Issue Workflow

## Purpose

Convert confirmed QA findings into clear GitHub issue drafts that Claude or Shri can act on later. This workflow keeps speculative findings out of GitHub and prevents accidental public/external actions.

By default, Claw only drafts issue text locally. Claw does not create GitHub issues unless Shri explicitly approves the specific local drafts to create.

The preferred semi-automatic workflow is:

```text
QA report -> local issue draft files -> Shri chooses drafts -> approved drafts become GitHub issues
```

## Rules

- Do not create GitHub issues without explicit approval.
- Do not push branches, open PRs, or change labels/milestones without explicit approval.
- Do not include secrets, tokens, raw `.env` values, private database URLs, or personal health data in issue bodies.
- Only create issues for confirmed findings with evidence and reproduction steps.
- Consolidate duplicate findings before drafting issues.
- Use labels consistently so the issue list stays useful.
- Keep each issue bounded to one fixable problem.
- If a finding is uncertain, keep it in the QA report as an investigation item instead of filing an issue.
- Store local drafts under `docs/qa/github/issue-drafts/` until they are approved or discarded.
- Treat local drafts as planning artifacts, not live GitHub issues.

## Issue Readiness Criteria

A QA finding is ready for GitHub when it has:

- severity
- clear title
- affected feature
- evidence
- reproduction steps or concrete check command
- expected behavior
- actual behavior
- likely files involved
- recommended next action
- privacy review confirming no sensitive values are included

## Recommended Labels

- `qa`
- `bug`
- `security`
- `privacy`
- `deployment`
- `frontend`
- `backend`
- `food-engine`
- `auth`
- `profile-weight`
- `docs`
- `tests`
- `blocked`
- `needs-claude`

Severity labels:

- `severity:blocker`
- `severity:high`
- `severity:medium`
- `severity:low`

## Issue Title Format

Use this format:

```text
[<area>] <specific bug or risk>
```

Examples:

```text
[food logging] Invalid multi-log quantity can save the wrong amount
[qa] Local QA script misses tracked sensitive file classes
[deployment] Backend CORS falls back to wildcard origins
```

## Issue Body Format

```markdown
## Summary

<one or two sentences>

## Severity

<Blocker | High | Medium | Low>

## Area

<frontend | backend | food-engine | auth | privacy | deployment | docs | tests>

## Evidence

- `<file path>:<line>` or command output summary
- <do not include secret values>

## Reproduction Steps

1. <step>
2. <step>
3. <step>

## Expected Behavior

<expected>

## Actual Behavior

<actual>

## Likely Files

- `<path>`

## Recommended Fix

<smallest safe fix>

## QA Notes

- Found by: Claw multi-agent QA
- Source report: <date/scope>
- Production changes required: yes / no / unknown
- Supabase/Render/Vercel changes required: yes / no / unknown
```

## GitHub Creation Workflow

1. Run or receive a QA report.
2. Identify confirmed findings.
3. Create local issue draft files under `docs/qa/github/issue-drafts/`.
4. Summarize the draft list for Shri.
5. Ask Shri which drafts to create on GitHub.
6. After approval, create only the approved issues.
7. Return created issue links and labels.

## Local Draft File Naming

Use this format:

```text
docs/qa/github/issue-drafts/YYYY-MM-DD-<area>-<short-title>.md
```

Examples:

```text
docs/qa/github/issue-drafts/2026-06-05-food-logging-invalid-multilog-quantity.md
docs/qa/github/issue-drafts/2026-06-05-qa-script-sensitive-file-class-scan.md
```

## Local Draft Header

Every local issue draft should begin with:

```markdown
---
github_status: draft
approved_for_github: false
created_on_github: false
github_issue_url:
severity: high
labels:
  - qa
  - bug
  - frontend
  - severity:high
---
```

Only drafts with `approved_for_github: true` may be created on GitHub.

## Approval Flow

When local drafts exist, ask for approval with:

```text
I created <N> local GitHub issue drafts.

Drafts:
1. <draft filename> — <title> — <severity> — <labels>
2. <draft filename> — <title> — <severity> — <labels>

Tell me which draft numbers to create on GitHub.
I will not create unapproved drafts.
```

## Approval Prompt

Use this exact shape before creating issues:

```text
I found <N> issue-ready QA findings.

Proposed GitHub issues:
1. <title> — <severity> — <labels>
2. <title> — <severity> — <labels>

I will not create them until you approve.
```
