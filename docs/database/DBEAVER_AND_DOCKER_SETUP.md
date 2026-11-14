# Video_AI - Docker PostgreSQL & DBeaver Setup Guide

## 1. PostgreSQL Docker Configuration (Phase 3)

### Service Specification
- **Container Name:** `video-ai-postgres`
- **Docker Image:** `postgres:16-alpine`
- **Host Port:** `5433` *(Mapped to container port `5432` to avoid collision with existing local Windows PostgreSQL 18 service on port 5432)*
- **Internal Docker Port:** `5432`
- **Volume:** `postgres_data` (persistent Docker volume)
- **Restart Policy:** `unless-stopped`
- **Healthcheck:** `pg_isready -U video_ai_user -d video_ai` (interval 10s, timeout 5s, retries 5)
- **Container Status:** `Up (healthy)`

### Database Credentials
- **Host:** `localhost` (from host machine / dev) / `postgres` (within Docker network)
- **Port:** `5433` (from host machine) / `5432` (within Docker network)
- **Database Name:** `video_ai`
- **Database User:** `video_ai_user`
- **Database Password:** `VideoAI_Secure_Db_2026!`
- **Connection URL (Host):** `postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai`
- **Connection URL (Docker):** `postgresql://video_ai_user:VideoAI_Secure_Db_2026!@postgres:5432/video_ai`

### Preserved Services
- `video-ai-redis` container was preserved untouched and verified running continuously (`Up 18+ hours`).

---

## 2. Environment Configuration

### `backend/.env`
Updated with database connection parameters:
```env
DB_HOST=localhost
DB_PORT=5433
DB_NAME=video_ai
DB_USER=video_ai_user
DB_PASSWORD=VideoAI_Secure_Db_2026!
DATABASE_URL=postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai
```

### `backend/.env.example`
Updated with safe template placeholders (no secrets):
```env
# ── Database (PostgreSQL) ──
DB_HOST=localhost
DB_PORT=5433
DB_NAME=video_ai
DB_USER=video_ai_user
DB_PASSWORD=your_secure_password_here
DATABASE_URL=postgresql://video_ai_user:your_secure_password_here@localhost:5433/video_ai
```

---

## 3. Database Migration & Schema Status

- **Schema:** 31 tables created using `backend/src/db/postgresSchema.sql`.
- **Data Parity:** 9,302 records migrated from SQLite to PostgreSQL with 100% data fidelity.
  - JSON strings correctly transformed to `JSONB`.
  - Timestamps mapped to `TIMESTAMPTZ`.
  - Booleans mapped to `BOOLEAN`.
  - Sequences synced (`setval`).
  - 0 orphaned foreign keys.
- **Node.js Test:** `backend/tests/postgresAccess.test.mjs` passed 11/11 tests.
- **Full Backend Suite:** 182/182 test files passed.

---

## 4. DBeaver Integration (Phase 7)

### Installation
- **Executable:** `C:\Users\Tran Huu Trung\AppData\Local\DBeaver\dbeaver.exe`
- **Version:** DBeaver 26.1.0 (with PostgreSQL 42.7.11 JDBC driver available)

### Pre-configured Workspace Connection
DBeaver's configuration file at:
`C:\Users\Tran Huu Trung\AppData\Roaming\DBeaverData\workspace6\General\.dbeaver\data-sources.json`
is pre-populated with the connection definition for `Video_AI (localhost:5433)`:
- Provider: `postgresql`
- Driver: `postgres-jdbc`
- Host: `localhost`
- Port: `5433`
- Database: `video_ai`
- User: `video_ai_user`
- Password: `VideoAI_Secure_Db_2026!`

### Launching & Testing Connection

1. **Verify Connection via CLI:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/test-db-connection.ps1
   ```
   Or using node:
   ```cmd
   node backend/scripts/test-pg.mjs
   ```

2. **Launch DBeaver GUI:**
   - From Windows Command Prompt / File Explorer:
     ```cmd
     scripts\open-dbeaver.bat
     ```
   - From PowerShell:
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts/open-dbeaver.ps1
     ```
   - Or open DBeaver from Start Menu:
     The connection `Video_AI (localhost:5433)` will appear automatically in the **Database Navigator** panel.
     Expand `Video_AI (localhost:5433)` -> `Databases` -> `video_ai` -> `Schemas` -> `public` -> `Tables` to view and query all 31 tables and live data.
