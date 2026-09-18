# TASK-017

## Title
Restrict provider logs query to prevent cross-user log exposure

## Type
security

## Priority
medium

## Autonomy
extra-verification

## Evidence
[backend/src/routes/v1/logs.js:30](file:///D:/E/Video_AI/backend/src/routes/v1/logs.js#L30): In `GET /api/v1/logs`, non-admin users execute `SELECT pl.*, p.title as project_title FROM provider_logs pl LEFT JOIN projects p ON pl.project_id = p.id WHERE p.user_id = ? OR pl.project_id IS NULL`. When provider calls occur without an associated project (such as provider health checks or background scripts), `pl.project_id IS NULL` is true, causing all such logs to be exposed to every authenticated user.

## Affected Areas
- `backend/src/routes/v1/logs.js`

## Expected Outcome
Non-admin queries in `logs.js` restrict results strictly to `WHERE p.user_id = ?`, ensuring non-admin users can only view provider logs belonging directly to their own projects.

## Constraints
Admins must retain access to all logs (including logs with null `project_id`).

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/logs.js')"`

## Status
PENDING
