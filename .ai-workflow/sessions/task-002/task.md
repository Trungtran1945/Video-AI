# TASK-002

## Title
Support ocrMode in pipeline runner stage resolution and retry

## Type
bug

## Priority
high

## Autonomy
extra-verification

## Evidence
[runner.js:122-130](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L122-L130), [runner.js:530-548](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L530-L548), and [generation.js:72-75](file:///D:/E/Video_AI/backend/src/routes/v1/generation.js#L72-L75): `STAGES.TRANSLATE_DUB` has only flat strings `['dub.ingest', 'dub.stt', 'dub.merge', ...]`. `runPipeline` checks `types.length === 1`, so `startDubSequential` is never reached. Even if `params.ocrMode` is true, `dub.stt` runs instead of `dub.ocr`. In addition, `flatStages('TRANSLATE_DUB')` excludes `dub.ocr`, so retrying `dub.ocr` returns 400 validation error.

## Affected Areas
- `backend/src/pipeline/runner.js`
- `backend/src/routes/v1/generation.js`

## Expected Outcome
When `params.ocrMode` is true, the pipeline correctly resolves and executes `dub.ocr` instead of `dub.stt`. `flatStages` and retry endpoints recognize `dub.ocr` as a valid runnable stage.

## Constraints
Preserve backward compatibility for non-OCR projects (`dub.stt` must remain default when `ocrMode` is false/absent).

## Suggested Verification
`cd backend && node --test tests/ocrTracks.test.mjs`

## Status
PENDING
