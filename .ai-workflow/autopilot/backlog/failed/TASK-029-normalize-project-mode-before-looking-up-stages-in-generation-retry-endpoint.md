# TASK-029

## Title
Normalize project mode before looking up STAGES in generation retry endpoint

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[`generation.js:82`](file:///D:/E/Video_AI/backend/src/routes/v1/generation.js#L82): In `POST /api/v1/projects/:id/jobs/:type/retry`, `const r = firstRunnableStage(STAGES[req.project.mode] || [], jobs)` passes `req.project.mode` verbatim to `STAGES`. While line 72 properly normalizes `req.project.mode` with `.toUpperCase().replace('-', '_')`, line 82 does not. If `req.project.mode` in the database is lowercase or hyphenated (`translate-dub`), `STAGES[req.project.mode]` returns `undefined`, evaluating to `[]` and causing `firstRunnableStage` to return no runnable stage.

## Affected Areas
- `backend/src/routes/v1/generation.js`

## Expected Outcome
Normalize the mode before indexing `STAGES`: `STAGES[String(req.project.mode || '').toUpperCase().replace('-', '_')] || []`.

## Constraints
Preserve existing validation error responses for unsupported modes.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/generation.js')"`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
