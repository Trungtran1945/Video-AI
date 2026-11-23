import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Core project lifecycle timestamps: last_heartbeat_at, started_at (defined in postgresSchema.sql)
export async function initSchema() {
  const pool = getPool()

  // 1. Create schema_migrations table for idempotent migration tracking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)

  // 2. Check if initial schema migration has been applied
  const migrationVersion = '001_initial_postgres_schema'
  const checkRes = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [migrationVersion]
  )

  if (checkRes.rows.length === 0) {
    const sqlPath = path.join(__dirname, 'postgresSchema.sql')
    if (fs.existsSync(sqlPath)) {
      const ddl = fs.readFileSync(sqlPath, 'utf8')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(ddl)
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [migrationVersion]
        )
        await client.query('COMMIT')
        console.log(`[DB] PostgreSQL schema verified/initialized (${migrationVersion})`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.error('[DB] Schema migration failed:', err.message)
        throw err
      } finally {
        client.release()
      }
    } else {
      console.warn(`[DB] Schema DDL file not found at ${sqlPath}`)
    }
  } else {
    console.log(`[DB] PostgreSQL schema is up-to-date (${migrationVersion})`)
  }

  // 3. Check and apply RLS Tenant Isolation Policies (002_rls_tenant_isolation)
  const rlsMigrationVersion = '002_rls_tenant_isolation'
  const rlsCheck = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [rlsMigrationVersion]
  )
  if (rlsCheck.rows.length === 0) {
    const rlsSqlPath = path.join(__dirname, 'rlsPolicies.sql')
    if (fs.existsSync(rlsSqlPath)) {
      const rlsDdl = fs.readFileSync(rlsSqlPath, 'utf8')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(rlsDdl)
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [rlsMigrationVersion]
        )
        await client.query('COMMIT')
        console.log(`[DB] RLS Tenant Isolation policies applied (${rlsMigrationVersion})`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.error('[DB] RLS migration failed:', err.message)
        throw err
      } finally {
        client.release()
      }
    }
  } else {
    try {
      await pool.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'video_ai_app') THEN
            GRANT USAGE ON SCHEMA public TO video_ai_app;
            GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO video_ai_app;
            GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO video_ai_app;
            GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO video_ai_app;
          END IF;
        END $$;
      `)
    } catch (_) {}
    console.log(`[DB] RLS Tenant Isolation is up-to-date (${rlsMigrationVersion})`)
  }

  // 4. Check and apply Cloudinary Metadata migration (003_cloudinary_metadata)
  const cloudinaryMigrationVersion = '003_cloudinary_metadata'
  const cloudinaryCheck = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [cloudinaryMigrationVersion]
  )
  if (cloudinaryCheck.rows.length === 0) {
    const migrationSqlPath = path.join(__dirname, 'migrations', '003_cloudinary_metadata.sql')
    const fallbackSqlPath = path.join(__dirname, 'cloudinaryMetadata.sql')
    const targetSqlPath = fs.existsSync(migrationSqlPath) ? migrationSqlPath : fallbackSqlPath
    if (fs.existsSync(targetSqlPath)) {
      const ddl = fs.readFileSync(targetSqlPath, 'utf8')
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(ddl)
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [cloudinaryMigrationVersion]
        )
        await client.query('COMMIT')
        console.log(`[DB] Cloudinary metadata schema migration applied (${cloudinaryMigrationVersion})`)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        console.error('[DB] Cloudinary metadata migration failed:', err.message)
        throw err
      } finally {
        client.release()
      }
    } else {
      console.warn(`[DB] Cloudinary metadata DDL file not found at ${targetSqlPath}`)
    }
  } else {
    console.log(`[DB] Cloudinary metadata schema is up-to-date (${cloudinaryMigrationVersion})`)
  }
}

export default { initSchema }
