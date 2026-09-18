# TASK-048

## Title
Query outputsApi and render actual thumbnails in outputs page

## Type
feature

## Priority
medium

## Autonomy
auto

## Evidence
[`Outputs.jsx:20-26, 74-88`](file:///D:/E/Video_AI/frontend/src/pages/Outputs.jsx#L20-L88): In `Outputs.jsx`, outputs are loaded using `projectsApi.list()` and filtered by `status === 'completed'` instead of calling `outputsApi.list()`. Because project records lack output entity attributes (`storage_key`, `thumbnail_key`), the card preview cannot render the generated thumbnail image `/storage/${output.thumbnail_key}` and always displays a generic `Film` placeholder icon.

## Affected Areas
- `frontend/src/pages/Outputs.jsx`

## Expected Outcome
Fetch items using `outputsApi.list()`, render `o.thumbnail_key ? /storage/${o.thumbnail_key} : null` inside an `<img>` tag within the card preview, and fall back to the placeholder icon only if no thumbnail exists.

## Constraints
Support project search filtering by `o.project_title || o.title`.

## Suggested Verification
`cd frontend && npm run build`

## Status
PENDING

FINAL_STATUS: SCAN_DONE
