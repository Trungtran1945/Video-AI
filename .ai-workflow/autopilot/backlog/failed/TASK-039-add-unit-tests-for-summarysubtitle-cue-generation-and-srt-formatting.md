# TASK-039

## Title
Add unit tests for summarySubtitle cue generation and SRT formatting

## Type
test

## Priority
medium

## Autonomy
auto

## Evidence
[`summarySubtitle.js:9-53`](file:///D:/E/Video_AI/backend/src/pipeline/stages/summarySubtitle.js#L9-L53): `splitSentences`, `srtTimestamp`, `buildCuesFromWindows`, and `toSrt` handle sentence boundary detection, multi-window timestamp calculation, and UTF-8 SRT serialization. However, `backend/tests/` contains zero test files covering `summarySubtitle.js` or its exported cue timing algorithms, leaving cue generation vulnerable to silent regressions during refactors.

## Affected Areas
- `backend/tests/summarySubtitle.test.mjs` (new)
- `backend/src/pipeline/stages/summarySubtitle.js`

## Expected Outcome
Create `backend/tests/summarySubtitle.test.mjs` testing `splitSentences`, `toSrt`, and `buildCuesFromWindows` with single and multiple windows, ensuring cues do not exceed window bounds and timestamps format correctly.

## Constraints
Use native Node test runner (`node --test`) matching existing test conventions.

## Suggested Verification
`cd backend && node --test tests/summarySubtitle.test.mjs`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
