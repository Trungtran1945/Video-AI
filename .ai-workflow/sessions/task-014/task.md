# TASK-014

## Title
Catch decryption authentication failures in crypto.decrypt to prevent 500 crashes

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[backend/src/lib/crypto.js:21-30](file:///D:/E/Video_AI/backend/src/lib/crypto.js#L21-L30): `decrypt()` calls `decipher.final()` without wrapping it in a try-catch block. In AES-256-GCM, if the ciphertext is corrupted, malformed, or if `MASTER_KEY` changed, `decipher.final()` throws `Unsupported state or unable to authenticate data`. In [backend/src/routes/v1/apiKeys.js:21](file:///D:/E/Video_AI/backend/src/routes/v1/apiKeys.js#L21), `GET /api/v1/api-keys` iterates over stored keys and invokes `decrypt()` directly, causing the entire endpoint to fail with an unhandled 500 error.

## Affected Areas
- `backend/src/lib/crypto.js`
- `backend/src/routes/v1/apiKeys.js`

## Expected Outcome
`decrypt(payload)` catches errors thrown by `decipher.final()`, logs a warning with redacted content, and safely returns `null` instead of throwing an unhandled exception. Endpoints handling keys gracefully display placeholder or empty values for keys that fail decryption.

## Constraints
Maintain standard output format for valid encrypted payloads. Do not log decrypted plaintexts or raw master keys.

## Suggested Verification
`cd backend && node --test tests/providerErrors.test.mjs`

## Status
PENDING
