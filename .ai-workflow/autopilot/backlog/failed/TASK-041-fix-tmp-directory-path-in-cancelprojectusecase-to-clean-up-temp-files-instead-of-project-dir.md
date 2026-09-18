# TASK-041

## Title
Fix tmp directory path in cancelProjectUseCase to clean up temp files instead of project dir

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`cancelProjectUseCase.js:44-50`](file:///D:/E/Video_AI/backend/src/usecases/cancelProjectUseCase.js#L44-L50): The cleanup logic intends to clean up temporary pipeline working files upon cancellation (`// Clean up temp files in storage/tmp/{projectId}`), but defines `const tmpDir = path.join(projectDir(projectId))` using `projectDir` instead of `tmpDirOf`. This deletes the permanent project directory `storage/projects/{projectId}` (which holds subtitles, audio tracks, and outputs) while leaking the actual multi-gigabyte temporary files in `storage/tmp/{projectId}`.

## Affected Areas
- `backend/src/usecases/cancelProjectUseCase.js`

## Expected Outcome
Import `tmpDirOf` from `../pipeline/context.js` and set `const tmpDir = tmpDirOf(projectId)`. Remove `tmpDir` on cancellation to free disk space without destroying `storage/projects/{projectId}`.

## Constraints
Do not delete source video keys or directories outside `config.storageDir`.

## Suggested Verification
`cd backend && node -e "import('./src/usecases/cancelProjectUseCase.js')"`

## Status
PENDING
