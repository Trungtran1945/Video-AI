# TASK-011

## Title
Clean up orphaned upload session directory on upload completion

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[backend/src/routes/v1/upload.js:46-54,147](file:///D:/E/Video_AI/backend/src/routes/v1/upload.js#L46-L54): During chunked upload initialization, a temporary folder is created at `storage/tmp/upload_sessions/<sessionId>`. In `POST /api/v1/uploads/:id/complete`, `fs.promises.rename(tmpPath, finalAbs)` moves the binary file to `storage/uploads/`, but leaves the empty session folder intact. Repeated uploads leave abandoned directories in `storage/tmp/upload_sessions/`.

## Affected Areas
- `backend/src/routes/v1/upload.js`

## Expected Outcome
Upon successful completion and rename of the uploaded file, `fs.promises.rm(sessionDir(session.id), { recursive: true, force: true })` cleans up the temporary session directory.

## Constraints
Directory removal must be best-effort and must not abort or fail a completed upload response.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/upload.js')"`

## Status
PENDING

---
