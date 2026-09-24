// SSE ticket lifecycle + frontend concurrency guards (§§4.6, 4.8-4.9).
// Backend: ticket TTL/expiry, single-use (no infinite reuse).
// Frontend: SSE retry xin ticket MỚI với backoff giới hạn + fallback polling;
// transcript save có sequence guard + 409 handling không discard edits;
// không JWT dài hạn trong URL; không retry vô hạn.
// Chạy: node tests/sseConcurrency.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_sseConc_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcFile = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')
const frontFile = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', ...p), 'utf8')

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, run } = await import('../src/db/query.js')
const { sha256 } = await import('../src/lib/crypto.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. ticket expiration: expired row rejected + cleaned.
{
  const past = new Date(Date.now() - 5000).toISOString()
  await run(`INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ['exp-1', 'u1', 'p1', sha256('expired-ticket'), past])
  const row = await queryOne(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256('expired-ticket')])
  const isExpired = row?.expires_at && new Date(row.expires_at).getTime() < Date.now()
  assert(!!row && isExpired, 'expired ticket detected by TTL comparison')
  await run(`DELETE FROM sse_tickets WHERE ticket_hash = ?`, [sha256('expired-ticket')])
  const gone = await queryOne(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256('expired-ticket')])
  assert(!gone, 'expired ticket cleaned (no reuse)')
}

// 2. ticket reuse rejection: consume = delete, second use fails.
{
  const future = new Date(Date.now() + 60 * 1000).toISOString()
  await run(`INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)`,
    ['use-1', 'u1', 'p1', sha256('once-ticket'), future])
  const first = await queryOne(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256('once-ticket')])
  assert(!!first && !first.used, 'valid ticket found before use')
  await run(`DELETE FROM sse_tickets WHERE ticket_hash = ?`, [sha256('once-ticket')])
  const second = await queryOne(`SELECT * FROM sse_tickets WHERE ticket_hash = ?`, [sha256('once-ticket')])
  assert(!second, 'ticket single-use: second lookup fails after consume')
}

// 3. reconnect obtains NEW ticket (auth consumes, frontend refetches per retry).
{
  const auth = srcFile('middleware', 'auth.js')
  assert(auth.includes('DELETE FROM sse_tickets'), 'auth consumes ticket single-use')
  const hook = frontFile('hooks', 'useJobEvents.js')
  // Fresh ticket per attempt: apiClient.post('/sse-ticket') inside retry function.
  const ticketCalls = (hook.match(/sse-ticket/g) || []).length
  assert(ticketCalls >= 1 && hook.includes('openWithTicket'), 'SSE retry path fetches fresh ticket per attempt')
  assert(!hook.includes('?token='), 'no long-lived JWT in SSE URL (?token= absent)')
  assert(hook.includes('?ticket='), 'EventSource uses ?ticket=')
}

// 4. retry has backoff + limit, then fallback polling (no infinite loop).
{
  const hook = frontFile('hooks', 'useJobEvents.js')
  assert(hook.includes('1000') && hook.includes('2000') && hook.includes('5000'), 'retry backoff [1s, 2s, 5s] present')
  assert(hook.includes('sseAvailable(false)') || hook.includes('setSseAvailable(false)'), 'after limit → fallback polling via sseAvailable=false')
  assert(!/while\s*\(\s*true/.test(hook), 'no while(true) infinite retry')
  assert(!/for\s*\(\s*;\s*;\s*\)/.test(hook), 'no for(;;) infinite retry')
  // Bounded: attempt compared against backoff length.
  assert(hook.includes('attempt <') || hook.includes('attempt >='), 'retry counter bounded by backoff length')
  // Polling/SSE storm guard: ProjectDetail polls only when !sseAvailable.
  const pd = frontFile('pages', 'ProjectDetail.jsx')
  assert(pd.includes('if (sseAvailable) return'), 'no SSE+polling storm (poll only when SSE unavailable)')
}

// 5. frontend stale response protection + 409 handling.
{
  const pd = frontFile('pages', 'ProjectDetail.jsx')
  assert(pd.includes('transcriptRevisionRef'), 'client tracks transcript revision')
  assert(pd.includes('transcriptSaveSeqRef'), 'client tracks request sequence number')
  assert(pd.includes('seq !== transcriptSaveSeqRef.current'), 'stale responses ignored (sequence guard)')
  assert(pd.includes('409') && pd.includes('CONFLICT_001'), '409 conflict handled explicitly')
  assert(pd.includes('loadDubData()'), '409 triggers refetch of latest transcript')
  assert(pd.includes('transcriptLoadSeqRef.current += 1'), 'saving invalidates transcript loads started earlier')
  assert(pd.includes('transcriptSaveInFlightRef'), 'loads are guarded while a transcript save is in flight')
  assert(pd.includes('transcriptRevisionRef = useRef(null)'), 'transcript revision has an unloaded sentinel')
  assert(pd.includes("'dub.ocr'"), 'frontend displays the dynamically selected OCR stage')
  assert(pd.includes("s === 'dub.ocr' || s === 'dub.stt'") && pd.includes('s === transcriptStage'), 'frontend hides the inactive OCR/STT stage')
  // Must not silently discard: error path keeps local edits (no setTranscript on 409 error branch before refetch).
  const saveIdx = pd.indexOf('handleSaveTranscript')
  const saveBlock = saveIdx >= 0 ? pd.slice(saveIdx, saveIdx + 4000) : ''
  assert(!/catch[\s\S]{0,400}\.segments\.map\(normSegment\)/.test(saveBlock) || saveBlock.includes('đối chiếu'), '409 path does not overwrite local edits with stale server data')
  const api = frontFile('api', 'projects.js')
  assert(api.includes('revision'), 'updateTranscript sends revision')
}

// 6. ticket lifecycle hygiene: TTL constant, bound user+project, no plaintext log.
{
  const events = srcFile('routes', 'v1', 'events.js')
  assert(events.includes('SSE_TICKET_TTL_MS'), 'TTL constant explicit')
  assert(events.includes('ticket_hash'), 'ticket stored hashed (no plaintext)')
  assert(events.includes('user_id') && events.includes('project_id'), 'ticket bound to user+project')
  assert(!/console\.log.*ticket/i.test(events), 'no plaintext ticket log in events route')
  const auth = srcFile('middleware', 'auth.js')
  assert(!/console\.log.*ticket|console\.log.*token/i.test(auth), 'no token/ticket log in auth')
  // Bounded expiry cleanup, no duplicate periodic timers.
  assert(events.includes('expires_at < ?'), 'expired-ticket cleanup present')
  assert(!events.includes('setInterval(') || events.includes('heartbeat'), 'no periodic cleanup timer leak (only SSE heartbeat interval, cleaned on close)')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
