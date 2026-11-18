import pg from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://video_ai_user:VideoAI_Secure_Db_2026!@localhost:5433/video_ai',
})

async function verify() {
  console.log('=== VERIFYING POSTGRESQL DATA INTEGRITY ===\n')

  // 1. Verify booleans
  const boolUsers = await pool.query('SELECT count(*)::int as cnt FROM users WHERE email_verified IS TRUE')
  const boolPresets = await pool.query('SELECT count(*)::int as cnt FROM style_presets WHERE is_system IS TRUE')
  console.log('Booleans check:')
  console.log(`  users.email_verified = TRUE: ${boolUsers.rows[0].cnt}`)
  console.log(`  style_presets.is_system = TRUE: ${boolPresets.rows[0].cnt}`)

  // 2. Verify JSONB
  const jsonParams = await pool.query('SELECT id, params FROM projects WHERE params IS NOT NULL LIMIT 2')
  console.log('\nJSONB check (projects.params):')
  for (const r of jsonParams.rows) {
    console.log(`  Project ${r.id}: typeof params = ${typeof r.params}, isObject = ${typeof r.params === 'object'}`)
  }

  // 3. Verify Timestamps
  const tsCheck = await pool.query('SELECT id, created_date FROM projects ORDER BY created_date DESC LIMIT 2')
  console.log('\nTimestamps check (projects.created_date):')
  for (const r of tsCheck.rows) {
    console.log(`  Project ${r.id}: created_date = ${r.created_date} (instanceof Date: ${r.created_date instanceof Date})`)
  }

  // 4. Verify Unicode (Vietnamese)
  const unicodeCheck = await pool.query('SELECT text, translation FROM transcript_segments WHERE translation IS NOT NULL LIMIT 2')
  console.log('\nUnicode check (transcript_segments):')
  for (const r of unicodeCheck.rows) {
    console.log(`  Text: "${r.text}" -> Translation: "${r.translation}"`)
  }

  // 5. Foreign keys integrity check
  console.log('\nForeign key integrity:')
  const orphanCheck = await pool.query(`
    SELECT count(*)::int as cnt FROM assets a
    LEFT JOIN projects p ON a.project_id = p.id
    WHERE p.id IS NULL
  `)
  console.log(`  Orphaned assets: ${orphanCheck.rows[0].cnt}`)

  console.log('\n✓ Integrity checks complete!')
}

verify()
  .catch(console.error)
  .finally(() => pool.end())
