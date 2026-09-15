// RED: best-effort LLM calls (e.g. dub.ttsAlign shorten) must fail fast when the
// provider is exhausted — burning 5 retries x ~60s suggested-wait per call turns
// a 12-segment ttsAlign into a 15-minute stage timeout (live incident d736).
// Run: node backend/tests/geminiFailFast.test.mjs
import { generateContent } from '../src/providers/geminiClient.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const quotaErr = () => ({
  ok: false, status: 429,
  headers: { get: () => null },
  json: async () => ({ error: { message: 'Quota exceeded for metric, limit: 20. Please retry in 59.3s.' } }),
})

// maxRetries: 0 -> single attempt, throws fast, exactly 1 HTTP call
{
  let calls = 0
  globalThis.fetch = async () => { calls++; return quotaErr() }
  const t0 = Date.now()
  let threw = null
  try {
    await generateContent({ model: 'gemini-3.6-flash', apiKey: 'k', body: { contents: [] }, maxRetries: 0 })
  } catch (e) { threw = e }
  const dt = Date.now() - t0
  assert(calls === 1, `maxRetries 0 -> exactly 1 HTTP call (got ${calls})`)
  assert(!!threw, 'maxRetries 0 -> still throws the quota error')
  assert(dt < 5000, `maxRetries 0 -> fails fast without suggested-wait (took ${dt}ms)`)
}

// maxRetries: 1 -> at most 2 calls
{
  let calls = 0
  globalThis.fetch = async () => { calls++; return quotaErr() }
  try {
    await generateContent({ model: 'gemini-3.6-flash', apiKey: 'k', body: { contents: [] }, maxRetries: 1 })
  } catch (_) {}
  assert(calls === 2, `maxRetries 1 -> exactly 2 HTTP calls (got ${calls})`)
}

// no opt -> default retry behavior unchanged (env default; no suggested-wait
// in this error so backoff stays 1s/2s and the check runs fast)
{
  const saved = process.env.GEMINI_MAX_RETRIES
  process.env.GEMINI_MAX_RETRIES = '2'
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: false, status: 503,
      headers: { get: () => null },
      json: async () => ({ error: { message: 'high demand, try again later' } }),
    }
  }
  try {
    await generateContent({ model: 'gemini-3.6-flash', apiKey: 'k2', body: { contents: [] } })
  } catch (_) {}
  assert(calls === 3, `default retries per env budget (calls=${calls})`)
  if (saved === undefined) delete process.env.GEMINI_MAX_RETRIES
  else process.env.GEMINI_MAX_RETRIES = saved
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
