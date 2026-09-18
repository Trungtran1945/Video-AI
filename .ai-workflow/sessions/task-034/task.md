# TASK-034

## Title
Add auto-refresh polling and manual reload to Queue page

## Type
feature

## Priority
low

## Autonomy
auto

## Evidence
[`Queue.jsx:16-27`](file:///D:/E/Video_AI/frontend/src/pages/Queue.jsx#L16-L27): In `Queue.jsx`, the job queue list is only fetched once on mount. When background jobs are actively running or queued, the user has no way of observing state changes without refreshing the entire browser tab, and there is no manual reload affordance.

## Affected Areas
- `frontend/src/pages/Queue.jsx`

## Expected Outcome
Add a manual reload button in the page header and a periodic polling interval (e.g., every 5-10 seconds) when active or pending jobs exist in the queue list.

## Constraints
Ensure cleanup of any interval timer on component unmount to prevent memory leaks.

## Suggested Verification
Verify `Queue.jsx` compiles and renders without errors.

## Status
PENDING

FINAL_STATUS: SCAN_DONE
