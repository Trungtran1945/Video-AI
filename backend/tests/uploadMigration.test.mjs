// RED: initSchema must migrate pre-existing DBs lacking upload_sessions.video_hash.
// Real failure: data.db created before 2026-09-12 has no video_hash column on
// upload_sessions -> POST /uploads/:id/complete throws "no such column: video_hash".
// Run: node backend/tests/uploadMigration.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.UPLOAD_SESSION_TTL_MINUTES = '17'

const { initSchema } = await import('../src/db/schema.js')
const { query, run, insert } = await import('../src/db/query.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

await initSchema()

// Clean previous run
await run("DELETE FROM upload_sessions WHERE id IN ('legacy-pending', 's1')")

// Insert test user and session
await run("INSERT INTO users (id, email, password) VALUES ('u1', 'u1@test.local', 'pw') ON CONFLICT DO NOTHING")
await run(`INSERT INTO upload_sessions (id, user_id, filename, size, mime, bytes_received, status, created_date, last_activity_at, expires_at)
  VALUES ('legacy-pending', 'u1', 'legacy.mp4', 10, 'video/mp4', 0, 'pending', NOW(), NOW(), NOW() + INTERVAL '17 minutes')`)

const legacySession = (await query('SELECT last_activity_at, expires_at FROM upload_sessions WHERE id = ?', ['legacy-pending']))[0]
const lastActivity = legacySession.last_activity_at instanceof Date
  ? legacySession.last_activity_at.toISOString()
  : String(legacySession.last_activity_at)
const expiresAt = legacySession.expires_at instanceof Date
  ? legacySession.expires_at.toISOString()
  : String(legacySession.expires_at)
assert(/T.*Z$/.test(lastActivity), 'migrated upload activity uses canonical ISO UTC')
assert(/T.*Z$/.test(expiresAt), 'migrated upload expiry uses canonical ISO UTC')
assert(Date.parse(expiresAt) - Date.parse(lastActivity) === 17 * 60 * 1000, 'migrated upload expiry uses configured TTL')

const cols = await query("SELECT name FROM pragma_table_info('upload_sessions')")
const columnNames = cols.map((c) => c.name)
assert(columnNames.includes('video_hash'), `upload_sessions.video_hash exists after migrate (cols=${columnNames.join(',')})`)
assert(columnNames.includes('last_activity_at'), 'upload_sessions.last_activity_at exists after migration')
assert(columnNames.includes('expires_at'), 'upload_sessions.expires_at exists after migration')
const uploadIndexes = await query("SELECT name FROM pragma_index_list('upload_sessions')")
const uploadIndexNames = uploadIndexes.map((index) => index.name)
assert(uploadIndexNames.includes('idx_upload_sessions_status_expires'), 'upload session cleanup index exists')

// updateById with video_hash (the exact failing query) must work
await run("INSERT INTO upload_sessions (id, user_id, filename, status) VALUES (?, ?, ?, ?)", ['s1', 'u1', 'a.mp4', 'pending'])
let ok = false
try {
  await insert('x_nope', { id: 'z' }).catch(() => {})
  const { updateById } = await import('../src/db/query.js')
  await updateById('upload_sessions', 's1', { status: 'completed', storage_key: 'uploads/f.mp4', video_hash: 'abc123' })
  ok = true
} catch (e) { console.error('update fail:', e.message) }
assert(ok, 'updateById upload_sessions with video_hash works on migrated DB')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
