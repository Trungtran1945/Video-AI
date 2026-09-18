# TASK-042

## Title
Ensure uploads directory exists before renaming in upload complete

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[`upload.js:145-147`](file:///D:/E/Video_AI/backend/src/routes/v1/upload.js#L145-L147): In `POST /api/v1/uploads/:id/complete`, the assembled binary at `tmpPath` is moved to `finalAbs` using `await fs.promises.rename(tmpPath, finalAbs)`, where `finalAbs = path.join(config.storageDir, 'uploads', finalName)`. Unlike the legacy multipart upload route which executes `fs.mkdirSync(dir, { recursive: true })`, the chunked upload routes never ensure that `storage/uploads` exists prior to `rename`. If a fresh container or clean directory receives a chunked upload first, `rename` fails with `ENOENT`.

## Affected Areas
- `backend/src/routes/v1/upload.js`

## Expected Outcome
Add `fs.mkdirSync(path.dirname(finalAbs), { recursive: true })` before invoking `fs.promises.rename(tmpPath, finalAbs)`.

## Constraints
Maintain the existing SHA-256 hash calculation and database record updates.

## Suggested Verification
`cd backend && node --test tests/uploadComplete.test.mjs`

## Status
PENDING
