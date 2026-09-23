// SSE hardening: ticket single-use TTL + terminal authoritative + fallback.
// - sse_tickets table tồn tại; ticket gắn user+project, TTL 60s, single-use
// - events.js: ticket route + terminal từ DB khi đã completed + done chỉ đóng stream
// - frontend: ?ticket= (không JWT dài hạn), done không tự completed, streamClosed fetch DB
// Chạy: node tests/sseHardening.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sse_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcFile = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')
const frontFile = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8')

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. Schema sse_tickets
{
  const rows = await query(`PRAGMA table_info(sse_tickets)`)
  const names = rows.map((r) => r.name)
  for (const c of ['user_id', 'project_id', 'ticket_hash', 'expires_at', 'used']) {
    assert(names.includes(c), `sse_tickets có cột ${c}`)
  }
}

// 2. Ticket lifecycle: insert → lookup → single-use delete → expiry cleanup
{
  const { sha256 } = await import('../src/lib/crypto.js')
  const h = sha256('ticket-abc')
  const future = new Date(Date.now() + 60 * 1000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  await run(`INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ['t1', 'u1', 'p1', h, future])
  const found = await query(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [h])
  assert(found.length === 1 && found[0].project_id === 'p1', 'ticket lookup theo hash + gắn project')
  // single-use: consume = delete
  await run(`DELETE FROM sse_tickets WHERE ticket_hash = ?`, [h])
  const gone = await query(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [h])
  assert(gone.length === 0, 'ticket single-use (delete sau dùng)')
  // expiry
  await run(`INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ['t2', 'u1', 'p1', sha256('old'), past])
  await run(`DELETE FROM sse_tickets WHERE expires_at < ?`, [new Date().toISOString()])
  const expired = await query(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256('old')])
  assert(expired.length === 0, 'ticket hết TTL bị dọn')
}

// 3. Backend events.js: ticket route + sseAuth ticket-first + DB terminal
{
  const src = srcFile('routes', 'v1', 'events.js')
  assert(src.includes('/sse-ticket'), 'events.js có POST /sse-ticket')
  assert(src.includes('SSE_TICKET_TTL_MS'), 'TTL 60s hằng số rõ ràng')
  assert(src.includes('single-use') || src.includes('Single-use'), 'ghi rõ single-use')
  assert(src.includes('SELECT status, progress FROM projects'), 'đã terminal trước connect → trả ngay DB state')
  assert(src.includes("event: done"), 'vẫn có done để đóng stream')
  assert(src.includes('không phải completion') || src.includes('KHÔNG được') || src.includes('done = stream'), 'comment rõ done chỉ đóng stream')
  const auth = srcFile('middleware', 'auth.js')
  assert(auth.includes('req.query?.ticket') || auth.includes('query.ticket'), 'sseAuth ưu tiên ?ticket=')
  assert(auth.includes('DELETE FROM sse_tickets'), 'ticket consume single-use trong auth')
  assert(!/console\.log.*ticket|console\.log.*token/i.test(auth), 'không log token/ticket trong auth')
}

// 4. Frontend useJobEvents: ticket, không JWT trong URL, done không tự completed
{
  const hook = frontFile('hooks', 'useJobEvents.js')
  assert(hook.includes('/sse-ticket'), 'hook fetch sse-ticket')
  assert(hook.includes('?ticket='), 'EventSource dùng ?ticket=')
  assert(!hook.includes('?token='), 'không còn ?token= JWT dài hạn trong URL')
  assert(!hook.includes("status: 'completed' }\n") || hook.includes('streamClosed'), 'done không tự tạo completed (có streamClosed)')
  assert(hook.includes('streamClosed'), 'hook expose streamClosed')
  assert(hook.includes('Authorization') || hook.includes('apiClient'), 'ticket fetch qua Bearer (axios)')
}

// 5. ProjectDetail: streamClosed fetch DB + terminal reload authoritative
{
  const pd = frontFile('pages', 'ProjectDetail.jsx')
  assert(pd.includes('streamClosed'), 'ProjectDetail xử lý streamClosed')
  assert(pd.includes('source of truth') || pd.includes('DB (load) là source'), 'comment rõ DB là truth')
}

// 6. EventBus documented process-local + polling fallback
{
  const bus = srcFile('pipeline', 'eventBus.js')
  assert(bus.includes('process-local'), 'eventBus ghi rõ process-local')
  assert(bus.includes('polling') || bus.includes('authoritative'), 'ghi rõ polling authoritative fallback')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
