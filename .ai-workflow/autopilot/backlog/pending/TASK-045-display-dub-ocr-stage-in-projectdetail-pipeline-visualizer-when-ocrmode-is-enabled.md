# TASK-045

## Title
Display dub.ocr stage in ProjectDetail pipeline visualizer when ocrMode is enabled

## Type
feature

## Priority
medium

## Autonomy
auto

## Evidence
[`ProjectDetail.jsx:42, 409-411`](file:///D:/E/Video_AI/frontend/src/pages/ProjectDetail.jsx#L42-L411): `ProjectDetail.jsx` defines `const DUB_STAGES_ALL = ['dub.ingest', 'dub.stt', 'dub.translate', 'dub.ttsAlign', 'dub.render']`. When a `TRANSLATE_DUB` project has `ocrMode: true`, the pipeline runner executes `dub.ocr` instead of `dub.stt`. Because `dub.ocr` is missing from `DUB_STAGES_ALL` and `stages` calculation, the UI visualizer renders `dub.stt` (which is never run) and completely hides `dub.ocr` progress.

## Affected Areas
- `frontend/src/pages/ProjectDetail.jsx`

## Expected Outcome
Conditionally include `'dub.ocr'` in the active stages array when `params.ocrMode` is true (or substitute `'dub.stt'` with `'dub.ocr'`), and add `dub.ocr: ScanText` to `stageIcons` in `ProjectDetail.jsx`.

## Constraints
Preserve normal `dub.stt` rendering when `ocrMode` is false or unset.

## Suggested Verification
`cd frontend && npm run build`

## Status
PENDING
