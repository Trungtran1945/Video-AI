# TASK-005

## Title
Handle audio-less and silent video input in dubIngest and summaryTranscribe

## Type
bug

## Priority
medium

## Autonomy
extra-verification

## Evidence
[dubIngest.js:26-28](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubIngest.js#L26-L28) and [summaryTranscribe.js:27-29](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryTranscribe.js#L27-L29) call `extractAudio(src, rawWav)` without inspecting `info.hasAudio`. If a video has no audio track, FFmpeg fails with `Output file does not contain any stream`, crashing the ingest stage.

## Affected Areas
- `backend/src/pipeline/stages/dubIngest.js`
- `backend/src/pipeline/stages/summaryTranscribe.js`
- `backend/src/media/mediaService.js`

## Expected Outcome
When `info.hasAudio` is `false`, `extractAudio` or the calling stage generates an empty/silent WAV file (`anullsrc`) matching the video's duration, or bypasses audio extraction in OCR mode, preventing fatal pipeline errors.

## Constraints
Do not break existing audio extraction for media containing valid audio streams.

## Suggested Verification
`cd backend && node --test tests/e2ePipeline30.test.mjs`

## Status
PENDING
