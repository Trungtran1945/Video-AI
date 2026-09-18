# TASK-024

## Title
Wire YouTube upload action button in Outputs page

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[Outputs.jsx:108-111](file:///D:/E/Video_AI/frontend/src/pages/Outputs.jsx#L108-L111): The "Táº£i lÃªn YouTube" button in the video card has no `onClick` handler. `frontend/src/api/outputs.js` exports `outputsApi.youtube(id, privacy)` and the backend endpoint `POST /api/v1/outputs/:id/youtube` is ready, but the button does nothing when clicked.

## Affected Areas
- `frontend/src/pages/Outputs.jsx`

## Expected Outcome
Connect the button to `outputsApi.youtube` with user feedback (loading indicator and success/error message or modal for privacy selection).

## Constraints
Do not alter existing CSS layout or navigation links in `Outputs.jsx`.

## Suggested Verification
`cd frontend && npm run build`

## Status
PENDING
