# TASK-021

## Title
Fix artifact cleanup for TRANSLATE_DUB outputs and thumbnail keys

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[runner.js:234](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L234): In `clearArtifacts()`, when `kind === 'outputs'`, the code checks `if (abs && !abs.startsWith(dir))` before unlinking. For `TRANSLATE_DUB`, `finalFile` is generated at `path.join(dir, 'final' + ext)` (`dubRender.js:66`), so `abs.startsWith(dir)` evaluates to true and the file is never deleted on rerun. Furthermore, `thumbnail_key` from `outputs` rows is never queried or deleted from disk, leaving orphaned thumbnail files on every pipeline rerun.

## Affected Areas
- `backend/src/pipeline/runner.js`

## Expected Outcome
Remove the `!abs.startsWith(dir)` exclusion so outputs in both `dir` and `outputs/` are unlinked on reset, and query `thumbnail_key` from `outputs` to unlink thumbnails as well.

## Constraints
Never delete source media keys or files outside `config.storageDir`.

## Suggested Verification
`cd backend && node --test tests/resumeOrder.test.mjs`

## Status
PENDING
