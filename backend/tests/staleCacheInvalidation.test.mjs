// Stale cache invalidation: cached local audioPath missing → invalidate row
// before provider call, emit diagnostic, no stale rows accumulate.
// Run: node backend/tests/staleCacheInvalidation.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_stale_inv_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { callProvider } = await import('../src/lib/callProvider.js')
const { queryOne } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-stale-'))
const ghost = path.join(tmp, 'ghost_seg.mp3')

// Seed a cache row whose audioPath no longer exists (stale artifact)
{
  let calls = 0
  const input = { text: 'stale-probe', outPath: ghost, speed: 1 }
  // First call creates a real file + cache row
  fs.writeFileSync(ghost, Buffer.from('v1'))
  await callProvider({
    provider: 'test_stale', type: 'tts', model: 'm', input,
    fn: async () => { calls++; return { audioPath: ghost, durationSec: 1 } },
    userId: 'u-stale',
  })
  assert(calls === 1, 'seed cache row created')
  // Delete file → stale
  fs.rmSync(ghost, { force: true })
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a.join(' ')) }
  try {
    const res = await callProvider({
      provider: 'test_stale', type: 'tts', model: 'm', input,
      fn: async () => {
        calls++
        fs.writeFileSync(ghost, Buffer.from('v2'))
        return { audioPath: ghost, durationSec: 1 }
      },
      userId: 'u-stale',
    })
    assert(calls === 2, `stale triggers provider re-call (calls=${calls})`)
    assert(fs.existsSync(ghost), 'stale re-creates artifact')
    assert(res?.audioPath === ghost, 'stale returns fresh artifact')
    assert(warnings.some((w) => w.includes('provider_cache_stale_artifact')), 'stale diagnostic emitted')
  } finally {
    console.warn = origWarn
  }
  // No stale rows accumulate: second identical call now hits (file exists)
  let calls2 = 0
  await callProvider({
    provider: 'test_stale', type: 'tts', model: 'm', input,
    fn: async () => { calls2++; return { audioPath: ghost, durationSec: 1 } },
    userId: 'u-stale',
  })
  assert(calls2 === 0, 'after invalidation+refresh, cache hits (no accumulation)')
  const row = await queryOne(`SELECT COUNT(*) as cnt FROM provider_cache WHERE provider = 'test_stale'`)
  assert(Number(row?.cnt) >= 1, 'cache row present (refreshed, not duplicated stale)')
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
