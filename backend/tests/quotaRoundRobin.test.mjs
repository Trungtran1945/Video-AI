// BE-04/BE-05 round-robin: priority order + per-key 429 cooldown.
// Fixture 2 api_keys cùng provider (priority 0/1): key priority nhỏ được chọn
// trước; key 429 liên tục → failover dùng key còn lại, job không FAILED.
// Dùng provider mock key (không tốn quota thật, không network).
// Run: node tests/quotaRoundRobin.test.mjs
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_roundrobin_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const { encrypt } = await import('../src/lib/crypto.js')
const { getProvider, listProvidersForCapability } = await import('../src/providers/registry.js')
const { selectBestApiKey } = await import('../src/services/quotaGuardService.js')
const { reportProviderFailure, clearProviderHealthForTests } = await import('../src/lib/providerHealth.js')
const { withProviderFailover } = await import('../src/lib/providerFailover.js')
const { runWithProviderScope } = await import('../src/lib/providerScope.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const userId = randomUUID()
const keyLo = { id: randomUUID(), priority: 0 }
const keyHi = { id: randomUUID(), priority: 1 }
await run(
  `INSERT INTO api_keys (id, user_id, provider, label, encrypted_key, is_active, priority) VALUES (?, ?, 'gemini', 'lo', ?, 1, ?)`,
  [keyLo.id, userId, encrypt('key-lo'), keyLo.priority]
)
await run(
  `INSERT INTO api_keys (id, user_id, provider, label, encrypted_key, is_active, priority) VALUES (?, ?, 'gemini', 'hi', ?, 1, ?)`,
  [keyHi.id, userId, encrypt('key-hi'), keyHi.priority]
)

// 1. resolveApiKey tôn trọng priority: key priority nhỏ được chọn trước.
{
  const got = await getProvider(userId, 'llm', { id: 'gemini' })
  assert(got.apiKeyId === keyLo.id, `priority nhỏ được chọn trước (got ${got.apiKeyId}, want ${keyLo.id})`)
}

// 2. selectBestApiKey trả key priority nhỏ khi cả 2 khỏe.
{
  clearProviderHealthForTests()
  const { apiKey } = await selectBestApiKey(userId, 'gemini')
  assert(apiKey?.id === keyLo.id, `selectBestApiKey chọn priority 0 (got ${apiKey?.id})`)
}

// 3. Key dính 429 → cooldown key đó, key còn lại được chọn (không null toàn cục).
{
  clearProviderHealthForTests()
  reportProviderFailure({ provider: 'gemini', apiKeyId: keyLo.id, errorCode: 'PROVIDER_RATE_LIMITED' })
  const { apiKey } = await selectBestApiKey(userId, 'gemini')
  assert(apiKey?.id === keyHi.id, `key 429 bị bỏ qua, chọn key còn lại (got ${apiKey?.id})`)
  clearProviderHealthForTests()
  const after = await selectBestApiKey(userId, 'gemini')
  assert(after.apiKey?.id === keyLo.id, 'hết cooldown → lại chọn priority 0')
}

// 4. Failover end-to-end qua candidates thật từ DB: key 429 → dùng key còn lại.
{
  clearProviderHealthForTests()
  const candidates = await listProvidersForCapability(userId, 'llm', { id: 'gemini' })
  const ids = candidates.map((c) => c.apiKeyId)
  assert(ids.length === 2 && ids[0] === keyLo.id && ids[1] === keyHi.id, `candidates theo priority [lo, hi] (got ${ids.join(',')})`)
  const calls = []
  await runWithProviderScope('test:roundrobin', async () => {
    const out = await withProviderFailover(
      { capability: 'LLM', candidates, maxAttempts: 2 },
      async (cand) => {
        calls.push(cand.apiKeyId)
        if (cand.apiKeyId === keyLo.id) throw Object.assign(new Error('Quota exceeded for free tier'), { status: 429 })
        return 'ok-hi'
      }
    )
    assert(out.result === 'ok-hi', 'failover trả kết quả key còn lại')
    assert(out.provider.apiKeyId === keyHi.id, `failover dừng ở key còn lại (got ${out.provider.apiKeyId})`)
  })
  assert(calls.join(',') === `${keyLo.id},${keyHi.id}`, `thử đúng thứ tự lo→hi (got ${calls.join('→')})`)
}

// 5. Key is_active=0 bị bỏ qua.
{
  clearProviderHealthForTests()
  await run(`UPDATE api_keys SET is_active = 0 WHERE id = ?`, [keyLo.id])
  const { apiKey } = await selectBestApiKey(userId, 'gemini')
  assert(apiKey?.id === keyHi.id, `bỏ qua key inactive (got ${apiKey?.id})`)
  await run(`UPDATE api_keys SET is_active = 1 WHERE id = ?`, [keyLo.id])
}

clearProviderHealthForTests()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
