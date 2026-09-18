# TASK-038

## Title
Separate SUMMARY and TRANSLATE_DUB pipeline visualizers in Dashboard

## Type
bug

## Priority
low

## Autonomy
auto

## Evidence
[`Dashboard.jsx:48-49,87-100`](file:///D:/E/Video_AI/frontend/src/pages/Dashboard.jsx#L48-L49) and [`constants.jsx:36-39`](file:///D:/E/Video_AI/frontend/src/lib/constants.jsx#L36-L39): `STAGE_ORDER` concatenates the 8 `SUMMARY` stages and the 6 `TRANSLATE_DUB` stages into a single 14-element array. `Dashboard.jsx` renders all 14 stages in a single continuous chain with sequential arrows (`1. Transcript phim -> ... -> 8. Xuáº¥t video -> 9. TÃ¡ch Ã¢m thanh & chuáº©n hoÃ¡ -> ... -> 14. Che chá»¯ & xuáº¥t video`), falsely implying that projects undergo all 14 stages in sequence instead of executing one of two distinct mutually-exclusive pipelines.

## Affected Areas
- `frontend/src/pages/Dashboard.jsx`
- `frontend/src/lib/constants.jsx`

## Expected Outcome
Display two separate pipeline tracks or tabbed views on the Dashboard ("Review Phim" and "Dá»‹ch & Lá»“ng Tiáº¿ng"), each displaying only its relevant stage progression.

## Constraints
Preserve existing stage icons and Vietnamese labels from `STAGE_LABELS`.

## Suggested Verification
Verify `Dashboard.jsx` compiles and renders both pipeline cards without errors.

## Status
PENDING
