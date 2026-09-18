# TASK-025

## Title
Add unit test coverage for SUMMARY mode packSegment and timeline assembly

## Type
test

## Priority
medium

## Autonomy
auto

## Evidence
[alignService.js:57](file:///D:/E/Video_AI/backend/src/pipeline/alignService.js#L57) and [summarySubtitle.js:27](file:///D:/E/Video_AI/backend/src/pipeline/stages/summarySubtitle.js#L27): All 36 test files in `backend/tests/` target the `TRANSLATE_DUB` pipeline. Core algorithms for `SUMMARY` mode (`packSegment`, `buildTimelineRows`, `buildCuesFromWindows`, `toSrt`) have zero unit tests, leaving timing and packing regressions completely undetected.

## Affected Areas
- `backend/tests/summaryAlign.test.mjs`

## Expected Outcome
Create `backend/tests/summaryAlign.test.mjs` testing `packSegment` duration tolerances (tolerance boundaries, empty candidates), `buildTimelineRows` sequential time alignment, and `buildCuesFromWindows` sentence splitting with valid SRT timestamps.

## Constraints
Use Node.js test runner (`node --test`). No external test packages.

## Suggested Verification
`cd backend && node --test tests/summaryAlign.test.mjs`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
