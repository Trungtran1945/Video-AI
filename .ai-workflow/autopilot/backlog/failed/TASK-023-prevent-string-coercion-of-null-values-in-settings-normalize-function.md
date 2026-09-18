# TASK-023

## Title
Prevent string coercion of null values in settings normalize function

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[settings.js:44](file:///D:/E/Video_AI/backend/src/routes/v1/settings.js#L44): In `normalize(patch)`, non-integer settings are normalized with `else out[f] = String(patch[f])`. When a client passes `{ voice_provider: null }` or `{ default_style: null }` to clear or reset a setting, `String(null)` produces the literal string `"null"`, which is saved into the database and causes provider and style lookups to fail.

## Affected Areas
- `backend/src/routes/v1/settings.js`

## Expected Outcome
Handle null explicitly: `out[f] = patch[f] === null ? null : String(patch[f])`, ensuring null values are preserved in database columns.

## Constraints
Maintain existing validation and integer coercion for `INT_FIELDS`.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/settings.js')"`

## Status
PENDING
