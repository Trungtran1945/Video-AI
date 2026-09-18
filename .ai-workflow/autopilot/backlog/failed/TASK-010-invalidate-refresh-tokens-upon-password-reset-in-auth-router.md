# TASK-010

## Title
Invalidate refresh tokens upon password reset in auth router

## Type
security

## Priority
high

## Autonomy
auto

## Evidence
[backend/src/routes/v1/auth.js:131-148](file:///D:/E/Video_AI/backend/src/routes/v1/auth.js#L131-L148): In `POST /api/v1/auth/reset-password`, the user's password hash is updated and the reset token marked used, but existing active refresh tokens are not revoked (`clearRefreshToken(user.id)` is never called, even though imported from `middleware/auth.js`). Any active refresh tokens retained by unauthorized sessions remain valid after password reset.

## Affected Areas
- `backend/src/routes/v1/auth.js`

## Expected Outcome
When a password is reset, `await clearRefreshToken(user.id)` is called to revoke all existing refresh tokens and terminate active sessions.

## Constraints
Must not disrupt existing login or token issuance flows.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/auth.js')"`

## Status
PENDING

---
