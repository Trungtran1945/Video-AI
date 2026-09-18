# TASK-026

## Title
Persist OCR bounding boxes into ocr_regions in dubOcr to restore subtitle mask positioning in dubRender

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[`dubOcr.js:80-84`](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubOcr.js#L80-L84): `aggregateBoxes` constructs spatial tracks with bounding boxes `bbox: { x, y, width, height }`, but `dubOcr` only writes to `transcript_segments` and discards all bounding box information. Consequently, the `ocr_regions` table remains empty for all OCR projects. When [`dubRender.js:47`](file:///D:/E/Video_AI/backend/src/pipeline/stages/dubRender.js#L47) loads regions via `loadSubtitleRegions` to construct `subtitles.ass`, it receives zero regions and defaults to placing translated subtitles at the bottom (`\an2`), failing the hardsub masking contract.

## Affected Areas
- `backend/src/pipeline/stages/dubOcr.js`
- `backend/src/db/query.js`

## Expected Outcome
During `dubOcr`, compute normalized ratio coordinates (`ratio_x = x / width`, `ratio_y = y / height`, `ratio_w = width / width`, `ratio_h = height / height`) for each persistent subtitle track and insert them into the `ocr_regions` table alongside `start_sec` and `end_sec`. This restores subtitle replacement positioning in `dubRender.js`.

## Constraints
Maintain compatibility with `loadSubtitleRegions` in `dubRender.js` and ensure all ratio coordinates are clamped between 0 and 1.

## Suggested Verification
`cd backend && node --test tests/assRegion.test.mjs`

## Status
PENDING
