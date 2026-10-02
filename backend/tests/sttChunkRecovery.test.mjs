// STT: chunking + sanity/recovery + quota-aware (no blind split/retry).
import { buildSttChunks, validateSttTiming } from '../src/pipeline/sttUtils.js'
import { classifyProviderError, ERROR_CODES } from '../src/lib/providerErrors.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

{
  // Short audio → single chunk (normal STT).
  const plan = buildSttChunks(120, { chunkSec: 300, overlapSec: 15 })
  assert(plan.length === 1 && plan[0].start === 0, 'short audio → single chunk')
}

{
  // Long audio → overlapping chunks.
  const plan = buildSttChunks(2000, { chunkSec: 300, overlapSec: 15 })
  assert(plan.length > 1, `long audio → chunked (${plan.length} chunks)`)
  const step = 300 - 15
  assert(plan[1].start === step, `overlap step preserved (${plan[1].start}s)`)
}

{
  // Malformed chunk (compressed timeline: transcript far beyond chunk) → recovery flag.
  const segs = [{ start: 0, end: 600, text: 'hello' }]
  const v = validateSttTiming(segs, 120)
  assert(v.ok === false && v.reason === 'compressed_timeline', 'compressed timeline detected as malformed')
}

{
  // Valid timeline passes.
  const segs = [{ start: 0, end: 2.4, text: 'a' }, { start: 2.4, end: 5.1, text: 'b' }]
  const v = validateSttTiming(segs, 120)
  assert(v.ok === true, 'valid timing passes sanity')
}

{
  // Invalid interval rejected.
  const v = validateSttTiming([{ start: 5, end: 5, text: 'x' }], 120)
  assert(v.ok === false, 'zero-length interval rejected')
}

{
  // Quota error → do NOT split/retry blindly (surface completed/total instead).
  const quota = classifyProviderError(Object.assign(new Error('quota exhausted'), { status: 429 }))
  assert(quota.code === ERROR_CODES.PROVIDER_QUOTA_EXCEEDED, 'STT quota classified as QUOTA')
  assert(quota.retryable === false, 'STT quota must not trigger blind chunk split/retry')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
