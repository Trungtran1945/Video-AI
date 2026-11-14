import pg from 'pg'

const { Pool } = pg
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5433),
  user: process.env.DB_USER || 'video_ai_user',
  password: process.env.DB_PASSWORD || 'VideoAI_Secure_Db_2026!',
  database: process.env.DB_NAME || 'video_ai',
})

try {
  const res = await pool.query(`
    SELECT current_database(), current_user, count(*)::int as tables 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    GROUP BY 1, 2
  `)
  console.log('[PG TEST SUCCESS]', res.rows[0])
} catch (err) {
  console.error('[PG TEST ERROR]', err)
  process.exit(1)
} finally {
  await pool.end()
}
