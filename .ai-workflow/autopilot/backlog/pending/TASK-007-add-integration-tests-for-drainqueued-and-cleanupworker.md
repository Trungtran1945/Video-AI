# TASK-007

## Title
Add integration tests for drainQueued and cleanupWorker

## Type
test

## Priority
medium

## Autonomy
auto

## Evidence
Currently, `backend/tests/redisGuard.test.mjs` only tests file content strings (e.g. `!drainSrc.includes('updated_date')`). There are no automated tests that verify `drainQueued` drains multiple queued users up to `maxConcurrentProjectsPerUser`, or that `cleanupWorker` correctly purges intermediate project files when `expires_at` has passed.

## Affected Areas
- `backend/tests/drainQueued.test.mjs`
- `backend/tests/cleanupWorker.test.mjs`

## Expected Outcome
New automated tests verify that:
1. `drainQueued` handles multiple users with queued projects independently.
2. `cleanupWorker` identifies expired projects with `status = 'completed'` and deletes intermediate directories while preserving outputs.

## Constraints
Tests must run cleanly with in-memory SQLite (`sql.js`) without requiring a live Redis server instance.

## Suggested Verification
`cd backend && node --test tests/drainQueued.test.mjs tests/cleanupWorker.test.mjs`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
