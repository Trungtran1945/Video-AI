// Health/readiness persistence exposure (Issue J):
// - getDbPersistenceHealth exposes HEALTHY/DEGRADED/WRITE_BLOCKED + counters
// - server.js /health reports persistenceState; /ready returns 503+ready:false
//   on WRITE_BLOCKED (decision 3.A), 200+ready:true otherwise
// - live boot probe: /health + /ready return persistenceState HEALTHY
// Run: node backend/tests/readinessState.test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// ── 1) static fences: routes exist with the right semantics ──
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(src.includes("app.get('/ready'"), 'server.js defines GET /ready')
  assert(src.includes('WRITE_BLOCKED') && src.includes('503'), '/ready maps WRITE_BLOCKED to 503')
  assert(src.includes('persistenceState'), '/health exposes persistenceState')
  assert(src.includes('consecutiveSaveFailures'), 'health exposes consecutiveSaveFailures')
  assert(src.includes('lastSuccessfulSaveAt'), 'health exposes lastSuccessfulSaveAt')
  assert(/res\.status\(ready \? 200 : 503\)/.test(src), '/ready status honors readiness predicate')
}

// ── 2) live boot probe on an isolated DB ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-ready-'))
const port = 32179
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    DB_PATH: path.join(tmpRoot, 'test.db'),
    STORAGE_DIR: path.join(tmpRoot, 'storage'),
    NODE_ENV: 'test',
    PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
child.stdout.on('data', (d) => { out += String(d) })
child.stderr.on('data', (d) => { out += String(d) })

const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch (_) {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

try {
  const health = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    if (!r.ok && r.status !== 503) return null
    return r.json()
  }, 25000, 'server boot')
  assert(health?.database?.persistenceState === 'HEALTHY',
    `live /health persistenceState HEALTHY (got ${health?.database?.persistenceState})`)
  assert(typeof health?.database?.consecutiveSaveFailures === 'number', '/health has consecutiveSaveFailures')
  assert('lastSuccessfulSaveAt' in (health?.database || {}), '/health has lastSuccessfulSaveAt')

  const readyRes = await fetch(`http://127.0.0.1:${port}/ready`)
  const ready = await readyRes.json()
  assert(readyRes.status === 200 && ready?.ready === true,
    `live /ready 200 ready:true when HEALTHY (got ${readyRes.status}/${ready?.ready})`)
  assert(ready?.database?.persistenceState === 'HEALTHY', '/ready reports persistenceState')
} catch (e) {
  failures++
  console.error('FAIL: live probe threw —', e?.message || e)
  console.error('--- server output ---\n' + out.slice(-3000))
} finally {
  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 1500))
  try { child.kill('SIGKILL') } catch (_) {}
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS')
process.exit(failures === 0 ? 0 : 1)
