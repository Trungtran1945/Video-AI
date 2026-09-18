# TASK-036

## Title
Add ocr_regions cleanup to clearArtifacts and RESETS in pipeline runner

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`runner.js:185-187,195-241`](file:///D:/E/Video_AI/backend/src/pipeline/runner.js#L185-L187): `RESETS['dub.ocr']`, `RESETS['dub.ingest']`, and `RESETS['dub.stt']` list `['transcriptSegments', 'audios', 'subtitles', 'outputs']`, but omit `ocr_regions`. Furthermore, `clearArtifacts()` has no handler for deleting `ocr_regions`. When a user retries or re-runs a TRANSLATE_DUB pipeline with OCR enabled, old bounding box entries in `ocr_regions` persist in the database, resulting in duplicate or obsolete mask coordinates being fed to `loadSubtitleRegions` in `dubRender.js`.

## Affected Areas
- `backend/src/pipeline/runner.js`

## Expected Outcome
Add `ocrRegions` to `clearArtifacts()` (`await run('DELETE FROM ocr_regions WHERE project_id = ?', [projectId])`), and include `ocrRegions` in `RESETS` for `dub.ingest`, `dub.stt`, and `dub.ocr`.

## Constraints
Do not affect projects in other modes (`SUMMARY`).

## Suggested Verification
`cd backend && node -e "import('./src/pipeline/runner.js')"`

## Status
PENDING
