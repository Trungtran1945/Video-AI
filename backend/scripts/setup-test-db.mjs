import 'dotenv/config'
import pg from 'pg'

export async function ensureTestDatabase(testDbUrl) {
  const parsed = new URL(testDbUrl)
  const targetDb = parsed.pathname.replace(/^\//, '')
  if (!targetDb) return

  // Connect to postgres or video_ai database to check targetDb existence
  const adminUrls = [
    new URL('/postgres', testDbUrl).toString(),
    new URL('/video_ai', testDbUrl).toString(),
  ]
  let client = null
  for (const url of adminUrls) {
    try {
      const c = new pg.Client({ connectionString: url })
      await c.connect()
      client = c
      break
    } catch (_) {}
  }
  if (client) {
    try {
      const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [targetDb])
      if (res.rows.length === 0) {
        const username = parsed.username || 'video_ai_user'
        await client.query(`CREATE DATABASE "${targetDb}" OWNER "${username}"`).catch(async () => {
          await client.query(`CREATE DATABASE "${targetDb}"`)
        })
        console.log(`[Test DB] Created database ${targetDb}`)
      }
    } catch (e) {
      console.warn(`[Test DB] Warning checking/creating database: ${e.message}`)
    } finally {
      await client.end().catch(() => {})
    }
  }

  // Initialize schema, test triggers, and seeds on testDbUrl
  process.env.DATABASE_URL = testDbUrl
  const { initSchema } = await import('../src/db/schema.js')
  await initSchema()

  const { setupTestTriggers } = await import('./setup-test-triggers.mjs')
  await setupTestTriggers()

  const { seed } = await import('../src/db/seed.js')
  await seed()
}

export async function cleanTestDatabase(testDbUrl) {
  process.env.DATABASE_URL = testDbUrl
  const { run } = await import('../src/db/query.js')
  const { closePool } = await import('../src/db.js')
  let lastErr = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await run('TRUNCATE TABLE projects, users, provider_cache, provider_logs, project_cleanup_tasks, reset_tokens, sse_tickets, youtube_accounts, youtube_oauth_states, email_otps, otp_codes CASCADE;')
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const isRetriable = err.code === '40P01' ||
        err.code === '55P03' ||
        err.code === '57P01' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ECONNREFUSED' ||
        err.message?.includes('deadlock') ||
        err.message?.includes('Connection terminated') ||
        err.message?.includes('ECONNRESET') ||
        err.message?.includes('socket')
      if (attempt < 5 && isRetriable) {
        await closePool().catch(() => {})
        await new Promise((r) => setTimeout(r, 200 * attempt))
      } else {
        throw err
      }
    }
  }
  if (lastErr) throw lastErr
  const { seed } = await import('../src/db/seed.js')
  await seed()
}

if (process.argv[1] && process.argv[1].endsWith('setup-test-db.mjs')) {
  const dbUrl = process.env.TEST_DATABASE_URL ||
    (process.env.DATABASE_URL
      ? process.env.DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, '/video_ai_test$1')
      : 'postgresql://video_ai_user:video_ai_pass@localhost:5433/video_ai_test')
  await ensureTestDatabase(dbUrl)
  console.log('[Test DB] Ready.')
  process.exit(0)
}
