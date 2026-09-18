# TASK-006

## Title
Wire confirmPreviewUseCase to resume pipeline execution from dub.ttsAlign

## Type
feature

## Priority
medium

## Autonomy
auto

## Evidence
[confirmPreviewUseCase.js:28-34](file:///D:/E/Video_AI/backend/src/usecases/confirmPreviewUseCase.js#L28-L34): `confirmPreviewUseCase` records `previewConfirmed: true` in `project.params` and returns `{ message: 'Preview confirmed, render queued' }`, but never calls `runPipeline(projectId, 'dub.ttsAlign')` or triggers any queue job. The project remains parked.

## Affected Areas
- `backend/src/usecases/confirmPreviewUseCase.js`

## Expected Outcome
Calling `confirmPreviewUseCase` starts `runPipeline(projectId, 'dub.ttsAlign')` asynchronously so translation preview confirmation seamlessly transitions into TTS alignment and video render.

## Constraints
Ensure `isPipelineRunning(projectId)` is checked to avoid duplicate concurrent pipeline runs.

## Suggested Verification
`cd backend && node --test tests/renderValidation.test.mjs`

## Status
PENDING
