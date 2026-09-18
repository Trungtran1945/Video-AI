# TASK-040

## Title
Prevent runPipeline from overwriting cancelled status with failed on abort

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`runner.js:590-614`](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L590-L614): When a user cancels a running project, `cancelProjectUseCase` marks the project status as `'cancelled'` and triggers `abortPipeline(projectId)`. The running stage detects the abort signal and throws `new Error('Cancelled')`. The enclosing `catch (err)` block in `runPipeline` catches this error and unconditionally executes `await updateById('projects', projectId, { status: 'failed' })`, publishes a `{ stage: '__project__', status: 'failed' }` event, and queues a failure email. This immediately overwrites the intentional `'cancelled'` status.

## Affected Areas
- `backend/src/pipeline/runner.js`

## Expected Outcome
In `runPipeline`'s `catch (err)` block, check if `signal.aborted` is true or if `err.message === 'Cancelled'`. If aborted, do not overwrite `projects.status` with `'failed'`, do not publish a failure event, and do not queue a failure notification.

## Constraints
Ensure genuine execution failures (network errors, LLM errors, ffmpeg errors) continue to mark the project as `'failed'` and emit failure events.

## Suggested Verification
`cd backend && node --test tests/redisGuard.test.mjs`

## Status
PENDING
