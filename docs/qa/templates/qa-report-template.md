# Lume QA Report: <scope>

## Verdict

Status: Safe to keep / Needs follow-up / Not safe to ship

Summary:

- <one to three sentence summary of the overall result>

## Git State

- Branch: `<branch>`
- Status: `<ahead/behind/dirty state>`
- Changed files:
  - `<path>`

## Scope

Reviewed:

- <feature, phase, PR, commit, or bug report>

Explicitly not reviewed:

- <areas outside scope>

## Agents Used

- Auth And Session QA Agent: used / not used
- Food Logging QA Agent: used / not used
- Profile, Weight, And Goals QA Agent: used / not used
- Backend API QA Agent: used / not used
- Frontend UX QA Agent: used / not used
- Privacy And Security QA Agent: used / not used

## Blockers

### <finding title>

- Severity: Blocker
- Evidence: <specific file, command output, screenshot, or reproduction result>
- Reproduction steps:
  1. <step>
  2. <step>
  3. <step>
- Expected behavior: <expected>
- Actual behavior: <actual>
- Likely files involved:
  - `<path>`
- Recommended next action: <smallest safe fix>

## High Priority

### <finding title>

- Severity: High
- Evidence: <specific evidence>
- Reproduction steps:
  1. <step>
  2. <step>
- Expected behavior: <expected>
- Actual behavior: <actual>
- Likely files involved:
  - `<path>`
- Recommended next action: <smallest safe fix>

## Medium Priority

### <finding title>

- Severity: Medium
- Evidence: <specific evidence>
- Reproduction steps:
  1. <step>
  2. <step>
- Expected behavior: <expected>
- Actual behavior: <actual>
- Likely files involved:
  - `<path>`
- Recommended next action: <smallest safe fix>

## Low Priority

### <finding title>

- Severity: Low
- Evidence: <specific evidence>
- Reproduction steps:
  1. <step>
  2. <step>
- Expected behavior: <expected>
- Actual behavior: <actual>
- Likely files involved:
  - `<path>`
- Recommended next action: <smallest safe fix>

## Checks Run

Commands:

```bash
<command>
```

Results:

- <pass/fail/blocked result>

Manual checks:

- <manual flow or inspection>

## Acceptance Criteria Review

- [ ] <acceptance criterion>
- [ ] <acceptance criterion>
- [ ] <acceptance criterion>

## Regression Risks

- <risk that could still be missed>
- <risk that needs a broader test later>

## Deployment Safety

- Production settings changed: yes / no
- Supabase schema/data changed: yes / no
- Render/Vercel settings changed: yes / no
- Env secrets changed or exposed: yes / no
- Migration required before deploy: yes / no

Notes:

- <deployment note>

## Recommended Next Phase

<smallest safe next step, preferably one bounded task for Claude or one focused QA run>

