# TASK-004

## Title
Fix cleanupWorker project status query and retention calculation

## Type
bug

## Priority
medium

## Autonomy
extra-verification

## Evidence
[cleanupWorker.js:29-32](file:///D:/E/Video_AI/backend/src/queue/workers/cleanupWorker.js#L29-L32) filters `WHERE status IN ('success', 'failed')`. However, finished projects in `projects` table are marked `status = 'completed'` ([runner.js:567](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L567)). Completed projects are never cleaned. Additionally, line 23 subtracts `retentionDays` from current time before comparing against `expires_at`, which was already offset by `retentionDays` during project creation.

## Affected Areas
- `backend/src/queue/workers/cleanupWorker.js`

## Expected Outcome
The query matches `status IN ('completed', 'failed')` and compares `expires_at < new Date().toISOString()`, allowing expired project intermediate files to be properly deleted.

## Constraints
Never delete files referenced in `outputs` table (`outputs` rows and final render media must remain intact).

## Suggested Verification
`cd backend && node --test tests/redisGuard.test.mjs`

## Status
PENDING
