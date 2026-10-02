// Regression: Gemini 429 quota must NOT be retried blindly on the same key.
// 503/rate-limit still retry with backoff; 401 never retries.
process.env.GEMINI_RPM = process.env.GEMINI_RPM || '1000'

const { generateContent } = await import('../src/providers/geminiClient.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json, headers = {} }) => ({
  ok, status,
  json: async () => json,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
})

// 1. Quota 429 → single call, errorCode QUOTA, retryable=false.
{
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return mkRes({ ok: false, status: 429, json: { error: { message: 'Quota exceeded for quota metric generate_content_free_tier_requests' } } })
  }
  try {
    await generateContent({ model: 'm', apiKey: 'k', body: { contents: [] }, label: 'Gemini LLM', maxRetries: 5 })
    assert(false, 'quota should throw')
  } catch (e) {
    assert(calls === 1, `quota NOT retried on same key (calls=${calls})`)
    assert(e.errorCode === 'PROVIDER_QUOTA_EXCEEDED' || /quota/i.test(e.message), 'quota error carries QUOTA code')
    assert(e.retryable === false, 'quota retryable=false')
  }
}

// 2. 503 still retries then succeeds.
{
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) return mkRes({ ok: false, status: 503, json: { error: { message: 'high demand, try again' } } })
    return mkRes({ ok: true, status: 200, json: { candidates: [{ content: { parts: [{ text: 'hi' }] } }] } })
  }
  try {
    const res = await generateContent({ model: 'm', apiKey: 'k', body: { contents: [] }, label: 'Gemini LLM', maxRetries: 5 })
    assert(calls === 2 && res.text === 'hi', `503 retried once then ok (calls=${calls})`)
  } catch (e) {
    assert(false, `503 should retry: ${e.message}`)
  }
}

// 3. 401 never retries.
{
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return mkRes({ ok: false, status: 401, json: { error: { message: 'API key not valid' } } })
  }
  try {
    await generateContent({ model: 'm', apiKey: 'bad', body: { contents: [] }, label: 'Gemini LLM' })
    assert(false, '401 should throw')
  } catch (_) {
    assert(calls === 1, `401 not retried (calls=${calls})`)
  }
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
