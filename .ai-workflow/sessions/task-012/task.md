# TASK-012

## Title
Add active_translate_provider to allowed settings in settings router

## Type
bug

## Priority
medium

## Autonomy
auto

## Evidence
[backend/src/routes/v1/settings.js:10-24](file:///D:/E/Video_AI/backend/src/routes/v1/settings.js#L10-L24): `ALLOWED` settings list contains `active_llm_provider`, `active_image_provider`, `active_video_provider`, `active_voice_provider`, `active_subtitle_provider`, but omits `active_translate_provider`. The column is present in SQLite (`schema.js:70`) and queried by `providers/registry.js:112`. When a user attempts to configure `active_translate_provider` via `PUT /api/v1/settings`, `normalize()` strips the parameter and the setting is never persisted.

## Affected Areas
- `backend/src/routes/v1/settings.js`

## Expected Outcome
`active_translate_provider` is included in the `ALLOWED` array of `settings.js`, allowing users to persist their preferred translation provider (e.g. `google_translate` vs `gemini`).

## Constraints
Preserve all existing allowed fields and normalization behavior.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/settings.js')"`

## Status
PENDING

---

FINAL_STATUS: SCAN_DONE
