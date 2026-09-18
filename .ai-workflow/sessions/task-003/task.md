# TASK-003

## Title
Fix drainQueued multi-user starvation and trigger on pipeline finish

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[drainQueued.js:48-63](file:///D:/E/Video_AI/backend/src/queue/workers/drainQueued.js#L48-L63) uses `queryOne` on a `GROUP BY user_id` query, returning only a single user record and ignoring all other users with queued projects. Furthermore, no repeat job triggers `drainQueued` on a recurring basis, and `runPipeline` in [runner.js:615-618](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L615-L618) does not trigger `drainQueued` upon completing an active run.

## Affected Areas
- `backend/src/queue/workers/drainQueued.js`
- `backend/server.js`
- `backend/src/pipeline/runner.js`

## Expected Outcome
`drainQueued` iterates through all users with queued projects using `query()`. `drainQueued` is scheduled via BullMQ repeat options (or triggered in `runPipeline`'s completion handler) so queued projects automatically resume when concurrency slots become available.

## Constraints
Do not exceed `config.maxConcurrentProjectsPerUser` per user. Handle Redis disconnected states gracefully.

## Suggested Verification
`cd backend && node --test tests/redisGuard.test.mjs`

## Status
PENDING
