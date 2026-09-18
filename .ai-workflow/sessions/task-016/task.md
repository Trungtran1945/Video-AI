# TASK-016

## Title
Enforce minimum password length in auth registration and password reset

## Type
security

## Priority
medium

## Autonomy
extra-verification

## Evidence
[backend/src/routes/v1/auth.js:24-27](file:///D:/E/Video_AI/backend/src/routes/v1/auth.js#L24-L27) and [backend/src/routes/v1/auth.js:133-134](file:///D:/E/Video_AI/backend/src/routes/v1/auth.js#L133-L134): `POST /api/v1/auth/register` and `POST /api/v1/auth/reset-password` only verify the presence/truthiness of `password` and `newPassword` (e.g. `!password`). Users can register accounts or reset passwords with single-character passwords, violating basic authentication security standards.

## Affected Areas
- `backend/src/routes/v1/auth.js`

## Expected Outcome
Both registration and password reset validate that the provided password has a minimum length of 8 characters, returning `400 Bad Request` with `ERR.VALIDATION` (`Máº­t kháº©u pháº£i cÃ³ Ã­t nháº¥t 8 kÃ½ tá»±`) if shorter.

## Constraints
Do not break existing user logins. Only enforce minimum length during new registration and password reset requests.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/auth.js')"`

## Status
PENDING
