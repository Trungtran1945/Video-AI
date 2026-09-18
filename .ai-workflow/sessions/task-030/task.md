# TASK-030

## Title
Normalize project mode and guard against empty stage groups in pipeline runner and regenerate endpoint

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`runner.js:477,567`](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L477) and [`projects.js:317`](file:///D:/E/Video_AI/backend/src/routes/v1/projects.js#L317): In `runPipeline`, `const stageGroups = STAGES[project.mode] || []` evaluates without mode string normalization. If `project.mode` is lowercase or hyphenated (`translate-dub`), `STAGES[project.mode]` returns `undefined`, falling back to `[]`. The loop `for (const group of stageGroups)` executes 0 iterations, and execution jumps directly to line 567: `await updateById('projects', projectId, { status: 'completed', progress: 100 })`, marking the project 100% completed without generating media outputs or executing any stages. Similarly, `projects.js:317` queries `STAGES[project.mode] || []` without normalization, causing `firstRunnableStage` to fail.

## Affected Areas
- `backend/src/pipeline/runner.js`
- `backend/src/routes/v1/projects.js`

## Expected Outcome
Normalize `project.mode` in `runPipeline` and `projects.js` via `String(project.mode || '').toUpperCase().replace('-', '_')`. In `runPipeline`, explicitly verify that `stageGroups.length > 0`; if empty or unrecognized, throw an error and fail the pipeline rather than marking the project as completed.

## Constraints
Maintain full compatibility with both `SUMMARY` and `TRANSLATE_DUB` modes and their respective stage configurations.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/runner.js')"`

## Status
PENDING
