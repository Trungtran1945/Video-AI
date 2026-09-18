# TASK-001

## Title
Prevent transcript PUT from nullifying translations on timing updates

## Type
bug

## Priority
high

## Autonomy
auto

## Evidence
[dubData.js:144-148](file:///D:/E/Video_AI/backend/src/routes/v1/dubData.js#L144-L148): In `PUT /api/v1/projects/:id/transcript`, line 144 assigns `const translation = typeof s.translation === 'string' ? s.translation : null`. When a client sends timing updates (`startSec`, `endSec`) without explicitly including `translation`, `s.translation` is undefined, setting `translation` to `null` and wiping existing segment translations in the database.

## Affected Areas
- `backend/src/routes/v1/dubData.js`
- `backend/tests/manualEdit.test.mjs`

## Expected Outcome
If `s.translation` is `undefined`, the segment's existing `translation` value (`seg.translation`) is preserved rather than overwritten with `null`.

## Constraints
Only set translation to `null` or new value when `translation` is explicitly provided in the payload; preserve existing `translation` when only updating timing.

## Suggested Verification
`cd backend && node --test tests/manualEdit.test.mjs`

## Status
PENDING
