# TASK-009

## Title
Sanitize project title in notifyWorker email notification to prevent HTML injection

## Type
security

## Priority
high

## Autonomy
extra-verification

## Evidence
[backend/src/queue/workers/notifyWorker.js:46-52](file:///D:/E/Video_AI/backend/src/queue/workers/notifyWorker.js#L46-L52): `projectTitle`, `mode`, and `statusText` are concatenated directly into raw HTML template:
`<p>Project <strong>${projectTitle}</strong> (${mode}) Ä‘Ã£ ${statusText}.</p>`
without escaping HTML characters (`<`, `>`, `&`, `"`, `'`). This enables HTML injection and potential phishing links in emails delivered to users.

## Affected Areas
- `backend/src/queue/workers/notifyWorker.js`

## Expected Outcome
All user-controlled and dynamic fields (`projectTitle`, `mode`, `statusText`) are sanitized/escaped before being interpolated into HTML email contents and subject line.

## Constraints
Preserve Vietnamese notification formatting and email delivery flow without modifying nodemailer configuration.

## Suggested Verification
`cd backend && node -e "import('./src/queue/workers/notifyWorker.js')"`

## Status
PENDING

---
