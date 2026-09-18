# TASK-013

## Title
Fix race condition in runPipeline and add running guards to regenerate and retry endpoints

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[backend/src/pipeline/runner.js:456-470](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L456-L470): `activeRuns.add(projectId)` is called after `await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])`. Two concurrent requests yield to the event loop on `await queryOne` and both proceed past `if (activeRuns.has(projectId)) return`, executing duplicate pipelines simultaneously. Furthermore, [backend/src/routes/v1/projects.js:311-326](file:///D:/E/Video_AI/backend/src/routes/v1/projects.js#L311-L326) (`POST /:id/regenerate`) and [backend/src/routes/v1/generation.js:70-92](file:///D:/E/Video_AI/backend/src/routes/v1/generation.js#L70-L92) (`POST /:id/jobs/:type/retry`) do not check `isPipelineRunning()`, initiating pipeline execution even when a run is already active.

## Affected Areas
- `backend/src/pipeline/runner.js`
- `backend/src/routes/v1/projects.js`
- `backend/src/routes/v1/generation.js`

## Expected Outcome
1. `activeRuns.add(projectId)` is called synchronously at the beginning of `runPipeline` before any `await`. If project lookup fails or throws, `activeRuns.delete(projectId)` is handled in a `finally` block.
2. `POST /projects/:id/regenerate` and `POST /projects/:id/jobs/:type/retry` check `isPipelineRunning(projectId)` and return `409` `PIPELINE_RUNNING` if the pipeline is currently running.

## Constraints
Do not alter stage execution order or change the public contract of `isPipelineRunning`.

## Suggested Verification
`cd backend && node --test tests/resumeOrder.test.mjs`

## Status
PENDING
