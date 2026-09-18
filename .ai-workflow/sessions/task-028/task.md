# TASK-028

## Title
Guard against null or missing segments in summaryTranscribe stage

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[`summaryTranscribe.js:56`](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryTranscribe.js#L56): In `summaryTranscribe`, `for (const s of res.segments)` iterates directly over `res.segments`. When an ASR provider returns an empty transcript, error response, or format where `segments` is missing or null (such as silent audio clips), the loop crashes with `TypeError: res.segments is not iterable`, abruptly failing the pipeline stage.

## Affected Areas
- `backend/src/pipeline/stages/summaryTranscribe.js`

## Expected Outcome
Safely fallback to an empty array `for (const s of (res?.segments || []))` and validate that `s.start` and `s.end` are finite numbers before pushing to the `segments` list.

## Constraints
Do not break existing transcript JSON schema output expected by `summaryScript.js`.

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/stages/summaryTranscribe.js')"`

## Status
PENDING
