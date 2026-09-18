# TASK-047

## Title
Copy ocr_regions when reusing cached project in projects router

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[`projects.js:159-181`](file:///D:/E/Video_AI/backend/src/routes/v1/projects.js#L159-L181): In `POST /api/v1/projects`, when a `TRANSLATE_DUB` project matches an existing completed project by `video_hash` with cache compatibility (`cachedProjectId`), the server copies `transcript_segments` into the new project. However, it does not copy records from `ocr_regions`. When the new project proceeds to `dubRender`, `loadSubtitleRegions` finds 0 regions, causing subtitle blur masks to fall back to generic positions instead of the detected bounding boxes.

## Affected Areas
- `backend/src/routes/v1/projects.js`

## Expected Outcome
If `cachedProjectId` is set and the project has `ocrMode: true`, query `ocr_regions WHERE project_id = ?` for `copySourceId` and insert them into `ocr_regions` with new UUIDs and the new `project.id`.

## Constraints
Do not copy `ocr_regions` if the candidate project did not run in OCR mode.

## Suggested Verification
`cd backend && node --test tests/cacheIdentity.test.mjs`

## Status
PENDING
