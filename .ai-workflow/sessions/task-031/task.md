# TASK-031

## Title
Isolate rate limit query by user in quotaGuardService to prevent cross-user key throttling

## Type
security

## Priority
high

## Autonomy
extra-verification

## Evidence
[`quotaGuardService.js:109-114`](file:///D:/E/Video_AI/backend/src/services/quotaGuardService.js#L109-L114): In `selectBestApiKey(userId, provider)`, the query `SELECT COUNT(*) as cnt FROM provider_logs WHERE provider = ? AND status = 'rate_limited' AND created_date >= ?` lacks tenant filtering. If any user encounters a 429 rate limit on a given provider, `recentLimit?.cnt > 0` evaluates to true for all users, skipping valid API keys for every user across the system.

## Affected Areas
- `backend/src/services/quotaGuardService.js`

## Expected Outcome
Scope the rate limit query by user: join `projects p ON pl.project_id = p.id WHERE p.user_id = ?` (matching the tenant-isolation pattern used in `getQuotaSnapshot`), ensuring that one user's quota exhaustion does not throttle another user's independent API keys.

## Constraints
Do not break existing provider log inserts or queries.

## Suggested Verification
`cd backend && node -e "import('./src/services/quotaGuardService.js')"`

## Status
PENDING
