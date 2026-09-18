# TASK-015

## Title
Import crypto in outputs.js for YouTube upload id generation

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[backend/src/routes/v1/outputs.js:54](file:///D:/E/Video_AI/backend/src/routes/v1/outputs.js#L54): `POST /api/v1/outputs/:id/youtube` assigns `id: crypto.randomUUID()`. However, `outputs.js` imports only `{ Router }`, `{ query, queryOne, insert, updateById }`, `{ authMiddleware, requireRole }`, `{ requireOutputOwner }`, and `{ sendError, ERR }`. Unlike other modules (`upload.js`, `edgeTts.js`) that explicitly import `crypto from 'node:crypto'`, `outputs.js` leaves `crypto` undeclared in its module scope.

## Affected Areas
- `backend/src/routes/v1/outputs.js`

## Expected Outcome
`import crypto from 'node:crypto'` is added to `outputs.js` (or use `uuidv4` matching project conventions), ensuring YouTube upload ID generation reliably succeeds.

## Constraints
Keep existing route handlers and response structures intact.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/outputs.js')"`

## Status
PENDING
