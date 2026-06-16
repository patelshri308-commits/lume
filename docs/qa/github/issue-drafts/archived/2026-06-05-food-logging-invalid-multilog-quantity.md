---
github_status: closed
approved_for_github: true
created_on_github: true
github_issue_url: https://github.com/patelshri308-commits/lume/issues/1
github_issue_number: 1
severity: high
labels:
  - qa
  - bug
  - frontend
  - food-logging
  - severity:high
---

# [food logging] Invalid multi-log quantity can save the wrong amount

## Summary

The multi-log quantity field can silently fall back to `1` for invalid, empty, zero, negative, or partially parsed values. This can cause users to save the wrong calorie and macro amounts.

## Severity

High

## Area

frontend / food-logging

## Evidence

- `frontend/App.tsx`: `getMultiplier()` uses `parseFloat(raw)` and falls back to `1`.
- `frontend/App.tsx`: the multi-log quantity `TextInput` accepts free text.
- `frontend/App.tsx`: scaled calories/macros are posted to `/logs`.

## Reproduction Steps

1. Open the multi-log screen.
2. Parse an item like `banana`.
3. Set `qty` to `0`, empty, `0,5`, or `1abc`.
4. Tap Log.

## Expected Behavior

Invalid quantities should block logging with a clear inline error, or valid locale decimals should be normalized safely before logging.

## Actual Behavior

Invalid or partially parsed quantity values can fall back to `1`, so the app may log a full serving when the user entered something else.

## Likely Files

- `frontend/App.tsx`

## Recommended Fix

Replace the `parseFloat` fallback behavior with strict validation. Normalize comma decimals if supported, reject partial parses like `1abc`, require `qty > 0`, and disable the Log button while any visible item has an invalid quantity.

## QA Notes

- Found by: Claw multi-agent QA
- Source report: 2026-06-05 MultiLogScreen quantity review
- Production changes required: no
- Supabase/Render/Vercel changes required: no

