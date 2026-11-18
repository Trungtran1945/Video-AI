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
}

export default { initSchema }
