// RED: initSchema must migrate pre-existing DBs lacking upload_sessions.video_hash.
// Real failure: data.db created before 2026-09-12 has no video_hash column on
// upload_sessions -> POST /uploads/:id/complete throws "no such column: video_hash".
// Run: node backend/tests/uploadMigration.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-mig-'))
process.env.DB_PATH = path.join(tmpRoot, 'old.db')

const { initSchema } = await import('../src/db/schema.js')
const { query, run, insert } = await import('../src/db/query.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// Simulate an OLD database: create upload_sessions WITHOUT video_hash, then initSchema must add it
{
  const { getDb, save } = await import('../src/db.js')
  const db = await getDb()
  db.run(`CREATE TABLE upload_sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, filename TEXT, size INTEGER DEFAULT 0,
    mime TEXT, tmp_path TEXT, bytes_received INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
    storage_key TEXT, created_date TEXT DEFAULT (datetime('now'))
  )`)
  save()
}
await initSchema()

const cols = await query("SELECT name FROM pragma_table_info('upload_sessions')")
assert(cols.some((c) => c.name === 'video_hash'), `upload_sessions.video_hash exists after migrate (cols=${cols.map((c) => c.name).join(',')})`)

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
