# Archived Legacy SQLite Scripts

These scripts are **archived and inactive**. They belong to the pre-PostgreSQL era when Video_AI used `sql.js` and local `data.db` SQLite files.

`sql.js` has been completely removed from `backend/package.json` in favor of PostgreSQL 16+ (`pg.Pool` via `DATABASE_URL`). Running these scripts directly against the current repository dependencies will fail with `ERR_MODULE_NOT_FOUND: Cannot find package 'sql.js'` (or expect historical `backend/data.db` / JSON dump files).

## Contents

- `audit_sqlite.mjs` — Legacy SQLite database schema/orphan/JSON/timestamp auditor (`sql.js`).
- `detailed_schema_dump.mjs` — Legacy SQLite schema dumper that generated `docs/database/detailed_sqlite_schema.json` (`sql.js`).
- `inspectSqlite.mjs` — Legacy SQLite table row-count inspector (`sql.js`).
- `inspect_json_samples.mjs` — Legacy SQLite JSON column sampler (`sql.js`).
- `inspect_orphans.mjs` — Legacy SQLite orphan foreign-key checker (`sql.js`).
- `inspect_tables.mjs` — Legacy SQLite `otp_codes` DDL/row inspector (`sql.js`).
- `migrateSqliteToPostgres.mjs` — One-time Phase 4 migration script that copied `backend/data.db` rows into PostgreSQL (`sql.js` + `pg`).
- `print_markdown_schema.mjs` — Companion formatter that turned `docs/database/detailed_sqlite_schema.json` into Markdown.
- `summarize_audit.mjs` — Companion formatter that summarized `docs/database/audit_data_raw.json`.

## Active PostgreSQL Equivalents

- `backend/scripts/test-pg.mjs` — Inspect active PostgreSQL tables and row counts.
- `backend/scripts/verify_pg_integrity.mjs` — Verify PostgreSQL booleans, JSONB, timestamps, Unicode, and foreign-key integrity.
- `backend/scripts/validate_sql.mjs` — Validate foreign-key references in `backend/src/db/postgresSchema.sql`.
- `backend/scripts/verify_criteria_matrix.mjs` — Verify PostgreSQL migration readiness and absence of active SQLite artifacts.
- `backend/scripts/check-legacy-artifacts.mjs` — CI guard blocking active `sql.js`, `DB_PATH`, `FORCE_SQLITE`, and `.db` file artifacts.
