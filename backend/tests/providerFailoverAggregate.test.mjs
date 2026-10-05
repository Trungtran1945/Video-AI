// BE-F03: failover dedupe-before-slice + aggregate retryability (PLAN §2.3/§4.2 QA-FO).
// BE-F01 (quota cycle): identity test A:key1,A:key2,B:key3 — dedupe theo đúng
// providerKey, không gộp nhầm 2 key khác nhau. BE-F02: Retry-After aggregate policy.
import { withProviderFailover, classifyAggregateFailover, aggregateRetryAfterMs } from '../src/lib/providerFailover.js'
import { clearProviderHealthForTests } from '../src/lib/providerHealth.js'
import { runWithProviderScope } from '../src/lib/providerScope.js'
import { ERROR_CODES } from '../src/lib/providerErrors.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const mkErr = (code, msg) => Object.assign(new Error(msg || code), { code })
const cand = (id, apiKeyId) => ({ id, apiKeyId: apiKeyId ?? `${id}-key1`, provider: {} })

// BE-F01: duplicate A:key1,A:key1,B:key2 maxAttempts=2 → thử A:key1,B:key2 (không bỏ sót B).
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-dedupe', async () => {
    const tried = []
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A', 'key1'), cand('A', 'key1'), cand('B', 'key2')], maxAttempts: 2 },
        async (c) => { tried.push(`${c.id}:${c.apiKeyId}`); throw mkErr(ERROR_CODES.PROVIDER_UNAVAILABLE, 'unavailable') }
      )
    } catch (e) {
      assert(e.code === 'NO_PROVIDER_AVAILABLE', 'dedupe case ends NO_PROVIDER_AVAILABLE')
      assert(tried.length === 2 && tried[0] === 'A:key1' && tried[1] === 'B:key2', `dedupe-before-slice tries A:key1,B:key2 (got ${tried.join(',')})`)
      assert(e.details?.attempted?.length === 2, 'attempted preserves 2 unique attempts')
    }
  })
}

// BE-F02: all-transient → retryable true + ALL_TRANSIENT.
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-transient', async () => {
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A'), cand('B')], maxAttempts: 2 },
        async () => { throw mkErr(ERROR_CODES.PROVIDER_TIMEOUT, 'timeout') }
      )
      assert(false, 'all-transient should throw')
    } catch (e) {
      assert(e.aggregate === 'ALL_TRANSIENT', `aggregate ALL_TRANSIENT (got ${e.aggregate})`)
      assert(e.retryable === true, 'all-transient retryable=true')
      assert(e.details?.attempted?.every((a) => a.retryable === true), 'per-attempt retryable preserved')
    }
  })
}

// all-quota → retryable false + ALL_QUOTA (không blind retry).
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-quota', async () => {
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A'), cand('B')], maxAttempts: 2 },
        async () => { throw mkErr(ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'quota exhausted') }
      )
      assert(false, 'all-quota should throw')
    } catch (e) {
      assert(e.aggregate === 'ALL_QUOTA', `aggregate ALL_QUOTA (got ${e.aggregate})`)
      assert(e.retryable === false, 'all-quota retryable=false')
    }
  })
}

// mixed → MIXED + retryable false + classification chi tiết.
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-mixed', async () => {
    let n = 0
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A'), cand('B')], maxAttempts: 2 },
        async () => {
          n++
          if (n === 1) throw mkErr(ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'quota exhausted')
          throw mkErr(ERROR_CODES.PROVIDER_TIMEOUT, 'timeout')
        }
      )
      assert(false, 'mixed should throw')
    } catch (e) {
      assert(e.aggregate === 'MIXED', `aggregate MIXED (got ${e.aggregate})`)
      assert(e.retryable === false, 'mixed retryable=false')
      assert(e.details?.attempted?.length === 2, 'mixed preserves both attempts')
    }
  })
}

// pure helper unit.
{
  assert(classifyAggregateFailover([]) === 'MIXED', 'empty → MIXED')
  assert(classifyAggregateFailover([{ code: 'PROVIDER_AUTH_FAILED' }]) === 'ALL_AUTH', 'single auth → ALL_AUTH')
}

// BE-F01 identity: A:key1,A:key2,B:key3 → cả 3 đều được thử (key khác nhau).
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-identity', async () => {
    const tried = []
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A', 'key1'), cand('A', 'key2'), cand('B', 'key3')], maxAttempts: 5 },
        async (c) => { tried.push(`${c.id}:${c.apiKeyId}`); throw mkErr(ERROR_CODES.PROVIDER_UNAVAILABLE, 'unavailable') }
      )
    } catch (e) {
      assert(tried.length === 3 && tried[0] === 'A:key1' && tried[1] === 'A:key2' && tried[2] === 'B:key3', `identity dedupe thử cả 3 key (got ${tried.join(',')})`)
      assert(e.details?.attempted?.length === 3, 'attempted preserves 3 distinct attempts')
    }
  })
}

// BE-F02 Retry-After aggregate: ALL_TRANSIENT → max; ALL_QUOTA/mixed → null.
{
  clearProviderHealthForTests()
  await runWithProviderScope('test:fo-retryafter', async () => {
    const t1 = () => Object.assign(new Error('timeout, retry in 5s'), { code: ERROR_CODES.PROVIDER_TIMEOUT })
    const t2 = () => Object.assign(new Error('overloaded'), { code: ERROR_CODES.PROVIDER_UNAVAILABLE, retryAfter: 2 })
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('A'), cand('B')], maxAttempts: 2 },
        async (c) => { throw (c.id === 'A' ? t1() : t2()) }
      )
      assert(false, 'all-transient should throw')
    } catch (e) {
      assert(e.aggregate === 'ALL_TRANSIENT', 'aggregate ALL_TRANSIENT')
      assert(e.retryAfterMs === 5000, `retryAfterMs = max(5000,2000) (got ${e.retryAfterMs})`)
    }
    try {
      await withProviderFailover(
        { capability: 'TTS', candidates: [cand('C'), cand('D')], maxAttempts: 2 },
        async () => { throw mkErr(ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'quota exhausted, retry in 60s') }
      )
      assert(false, 'all-quota should throw')
    } catch (e) {
      assert(e.aggregate === 'ALL_QUOTA', 'aggregate ALL_QUOTA')
      assert(e.retryAfterMs == null, 'ALL_QUOTA → không retry ngay (null)')
    }
  })
  assert(aggregateRetryAfterMs([]) === null, 'empty → null')
  assert(aggregateRetryAfterMs([{ code: 'PROVIDER_TIMEOUT', retryable: true }]) === null, 'không hint → null (caller dùng backoff mặc định)')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
