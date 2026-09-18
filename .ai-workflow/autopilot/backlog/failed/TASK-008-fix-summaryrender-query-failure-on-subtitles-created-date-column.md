# TASK-008

## Title
Fix summaryRender query failure on subtitles created_date column

## Type
bug

## Priority
critical

## Autonomy
extra-verification

## Evidence
[backend/src/pipeline/stages/summaryRender.js:54](file:///D:/E/Video_AI/backend/src/pipeline/stages/summaryRender.js#L54): `summaryRender` queries `SELECT storage_key FROM subtitles WHERE project_id = ? ORDER BY created_date DESC`. In [backend/src/db/schema.js:184-191](file:///D:/E/Video_AI/backend/src/db/schema.js#L184-L191), the `subtitles` table schema defines only `id`, `project_id`, `format`, `language`, `storage_key`, `cues` without `created_date`. When executing `summaryRender`, SQLite throws `SqliteError: no such column: created_date`, halting the summary pipeline during video render.

## Affected Areas
- `backend/src/db/schema.js`
- `backend/src/pipeline/stages/summaryRender.js`
- `backend/src/pipeline/stages/summarySubtitle.js`

## Expected Outcome
1. `initSchema()` in `schema.js` defines `created_date TEXT DEFAULT (datetime('now'))` on the `subtitles` table and includes an `ALTER TABLE subtitles ADD COLUMN created_date TEXT DEFAULT (datetime('now'))` migration block.
2. `summarySubtitle.js` populates `created_date` when inserting new subtitle records.
3. `summaryRender.js` successfully queries subtitles ordered by `created_date DESC`.

## Constraints
Migration must use non-destructive `ALTER TABLE subtitles ADD COLUMN created_date` wrapped in try/catch to maintain backward compatibility with existing databases.

## Suggested Verification
`cd backend && node --test tests/e2ePipeline30.test.mjs`

## Status
PENDING

---
