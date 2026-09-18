# TASK-046

## Title
Support cancelled status text in notifyWorker email notifications

## Type
bug

## Priority
low

## Autonomy
auto

## Evidence
[`notifyWorker.js:44-48`](file:///D:/E/Video_AI/backend/src/queue/workers/notifyWorker.js#L44-L48): `notifyWorker` computes `const statusText = status === 'success' ? 'thÃ nh cÃ´ng' : 'tháº¥t báº¡i'`. When `cancelProjectUseCase` enqueues a notification job with `status: 'cancelled'`, `statusText` evaluates to `'tháº¥t báº¡i'`, generating confusing emails that tell users their project failed when they explicitly cancelled it.

## Affected Areas
- `backend/src/queue/workers/notifyWorker.js`

## Expected Outcome
Map `status === 'cancelled'` to `'Ä‘Ã£ huá»·'` in `statusText`, subject line, and HTML template body.

## Constraints
Keep `'thÃ nh cÃ´ng'` for success and `'tháº¥t báº¡i'` for failed status.

## Suggested Verification
`cd backend && node -e "import('./src/queue/workers/notifyWorker.js')"`

## Status
PENDING
