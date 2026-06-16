---
github_status: closed
approved_for_github: true
created_on_github: true
github_issue_url: https://github.com/patelshri308-commits/lume/issues/2
github_issue_number: 2
severity: medium
labels:
  - qa
  - bug
  - privacy
  - tests
  - severity:medium
---

# [qa] Local QA script should fail on tracked sensitive file classes

## Summary

The local QA privacy scan checks for high-confidence secret content patterns, but it does not currently fail on sensitive tracked file classes such as `.env`, `.db`, `.sqlite`, `.csv`, `.pem`, or `.key`.

## Severity

Medium

## Area

privacy / tests

## Evidence

- `docs/qa/checklists/privacy-security.md` expects checks for tracked `.env`, database, CSV, private key, and credential files.
- `scripts/qa_lume_local.sh` scans file contents but does not currently enforce sensitive file-class tracking rules.

## Reproduction Steps

1. Run `scripts/qa_lume_local.sh --no-backend --no-frontend`.
2. Run `git status --short --ignored | rg "\\.env|\\.db|__pycache__|\\.pytest_cache|node_modules|\\.expo"`.
3. Compare the privacy checklist expectations to the script output.

## Expected Behavior

The QA script should fail if sensitive file classes are tracked or unignored, and it should summarize ignored sensitive local files by path only without printing values.

## Actual Behavior

The script can pass with `No high-confidence tracked secret patterns found` even though it does not enforce the sensitive file-class rules from the checklist.

## Likely Files

- `scripts/qa_lume_local.sh`
- `docs/qa/checklists/privacy-security.md`

## Recommended Fix

Add a redacted file-class scan that fails on tracked or unignored `.env`, `.db`, `.sqlite`, `.csv`, `.pem`, `.key`, and similar sensitive files. Separately summarize ignored sensitive local files by path only.

## QA Notes

- Found by: Claw multi-agent QA
- Source report: 2026-06-05 QA system review
- Production changes required: no
- Supabase/Render/Vercel changes required: no

