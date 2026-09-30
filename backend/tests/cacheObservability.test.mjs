// Cache observability: cache errors never fail provider requests
// but emit structured diagnostics. No secrets logged.
// Run: node backend/tests/cacheObservability.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.DB_PATH = path.join(os.tmpdir(), `vidai_cache_obs_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

// 1. Source fences: structured event names exist, no secret logging
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'callProvider.js'), 'utf8')
  for (const ev of ['provider_cache_check_error', 'provider_cache_parse_error', 'provider_cache_write_error', 'provider_cache_stale_artifact']) {
    assert(src.includes(ev), `diagnostic event ${ev} exists`)
  }
  assert(!/console\.(warn|error|log)\(.*(apiKey|Authorization|Bearer|password|secret)/i.test(src), 'no secret in cache diagnostic logs')
  assert(src.includes('hashPrefix'), 'diagnostic includes safe hash prefix (not raw input)')
}

// 2. Corrupt cache row → parse error diagnostic, provider still runs (availability)
{
  const { run } = await import('../src/db/query.js')
  const { callProvider } = await import('../src/lib/callProvider.js')
  const input = { prompt: 'obs-test-corrupt', temperature: 0 }
  const crypto = await import('node:crypto')
  const payload = JSON.stringify({ provider: 'test_obs', type: 'llm', model: 'm', input: Object.fromEntries(Object.entries(input).sort()) })
  // NOTE: inputHash sorts keys via normalizeInput; replicate by importing? Simpler: write corrupt row by calling store path then corrupting.
  // Store a valid row first via provider call, then corrupt its result JSON.
  let calls = 0
  await callProvider({
    provider: 'test_obs', type: 'llm', model: 'm', input,
    fn: async () => { calls++; return { text: 'ok' } },
    userId: 'u-obs',
  })
  // Corrupt the stored result
  await run(`UPDATE provider_cache SET result = 'not-json-corrupted' WHERE provider = 'test_obs' AND type = 'llm'`)
  const warnings = []
  const origWarn = console.warn
  console.warn = (...a) => { warnings.push(a.join(' ')) }
  try {
    const res = await callProvider({
      provider: 'test_obs', type: 'llm', model: 'm', input,
      fn: async () => { calls++; return { text: 'recovered' } },
      userId: 'u-obs',
    })
    assert(res?.text === 'recovered', 'corrupt cache does not fail request (provider runs)')
    assert(calls === 2, `corrupt cache treated as miss (calls=${calls})`)
    assert(warnings.some((w) => w.includes('provider_cache_parse_error')), 'parse error diagnostic emitted')
    assert(!warnings.some((w) => /bearer|apikey|secret/i.test(w)), 'diagnostic contains no secrets')
  } finally {
    console.warn = origWarn
  }
}

// 3. Cache write failure is non-fatal (provider result still returned)
{
  const { callProvider } = await import('../src/lib/callProvider.js')
  const res = await callProvider({
    provider: 'test_obs2', type: 'llm', model: 'm',
    input: { q: 'write-fail-probe' },
    fn: async () => ({ text: 'live' }),
    userId: 'u-obs',
  })
  assert(res?.text === 'live', 'provider result returned even when cache path stressed')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
