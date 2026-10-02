// Provider failover: A quota/rate → B succeeds; A+B fail → C; all fail → proper failure.
// Uses withProviderFailover + in-memory health (no network, no secrets).
import { withProviderFailover } from '../src/lib/providerFailover.js'
import { clearProviderHealthForTests } from '../src/lib/providerHealth.js'
import { runWithProviderScope } from '../src/lib/providerScope.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const quotaErr = () => Object.assign(new Error('Quota exceeded for free tier'), { status: 429 })
const rateErr = () => Object.assign(new Error('Too many requests, retry in 1s'), { status: 429 })
const okProvider = (id, text = 'ok') => ({ id, apiKeyId: `${id}-key1`, provider: {} })

async function runCase(name, candidates, behaviors, expect) {
  clearProviderHealthForTests()
  let calls = []
  await runWithProviderScope(`test:${name}`, async () => {
    try {
      const out = await withProviderFailover(
        { capability: 'TTS', candidates, maxAttempts: 4 },
        async (cand) => {
          calls.push(cand.id)
          const b = behaviors[cand.id]
          if (b === 'throw-quota') throw quotaErr()
          if (b === 'throw-rate') throw rateErr()
          return `${textFor(cand.id)}`
        }
      )
      if (expect.ok) {
        assert(out.provider.id === expect.provider, `${name}: failover lands on ${expect.provider} (got ${out.provider.id})`)
        assert(!calls.slice(0, -1).includes(out.provider.id), `${name}: no blind same-key retry (${calls.join('→')})`)
      } else {
        assert(false, `${name}: expected failure but got ${out.provider.id}`)
      }
    } catch (err) {
      if (!expect.ok) {
        assert(err.code === 'NO_PROVIDER_AVAILABLE', `${name}: all-fail → NO_PROVIDER_AVAILABLE (got ${err.code})`)
        assert(err.retryable === false, `${name}: NO_PROVIDER_AVAILABLE retryable=false`)
      } else {
        assert(false, `${name}: unexpected throw ${err.code || err.message}`)
      }
    }
  })
  function textFor() { return 'ok' }
}

await runCase('A-quota-B-ok', [okProvider('A'), okProvider('B')], { A: 'throw-quota' }, { ok: true, provider: 'B' })
await runCase('A-rate-B-ok', [okProvider('A'), okProvider('B')], { A: 'throw-rate' }, { ok: true, provider: 'B' })
await runCase('AB-fail-C-ok', [okProvider('A'), okProvider('B'), okProvider('C')], { A: 'throw-quota', B: 'throw-rate' }, { ok: true, provider: 'C' })
await runCase('all-fail', [okProvider('A'), okProvider('B')], { A: 'throw-quota', B: 'throw-quota' }, { ok: false })

// Non-failover errors must propagate immediately (no swallowing).
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:nonfailover', async () => {
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [okProvider('A'), okProvider('B')] },
        async () => { throw Object.assign(new Error('invalid request payload'), { status: 400 }) }
      )
      assert(false, 'invalid-request should throw')
    } catch (err) {
      assert(err.code !== 'NO_PROVIDER_AVAILABLE', 'non-failover error propagates unwrapped')
    }
  })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
