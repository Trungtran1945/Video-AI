import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai',
})

try {
  const res = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    ORDER BY table_name
  `)
  console.log('[PG TABLES COUNT]', res.rows.length)
  for (const row of res.rows) {
    const countRes = await pool.query(`SELECT count(*)::int as cnt FROM "${row.table_name}"`)
    console.log(`  ${row.table_name.padEnd(25)}: ${countRes.rows[0].cnt}`)
  }
} catch (err) {
  console.error('[PG TEST ERROR]', err)
  process.exit(1)
} finally {
  await pool.end()
}

