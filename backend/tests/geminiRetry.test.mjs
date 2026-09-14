// TDD: Gemini 503 high-demand must be retried with backoff, not thrown immediately.
// Also: 401 must NOT be retried. Uses mocked global fetch (no network, no key).
// Run: node backend/tests/geminiRetry.test.mjs
process.env.GEMINI_RPM = process.env.GEMINI_RPM || '1000'

const { generateContent } = await import('../src/providers/geminiClient.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const okPayload = {
  candidates: [{ content: { parts: [{ text: '{"segments":[]}' }] } }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
}
const mkRes = ({ ok, status, json, headers = {} }) => ({
  ok, status,
  json: async () => json,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
})

// 1. Two 503s then success -> resolves (would throw immediately before fix).
let calls = 0
globalThis.fetch = async () => {
  calls++
  if (calls <= 2) {
    return mkRes({ ok: false, status: 503, json: { error: { message: 'This model is currently experiencing high demand. Please try again later.' } } })
  }
  return mkRes({ ok: true, status: 200, json: okPayload })
}
try {
  const t0 = Date.now()
  const res = await generateContent({ model: 'test-model', apiKey: 'k', body: { contents: [] }, label: 'Gemini LLM' })
  const dt = Date.now() - t0
  assert(res.text.includes('segments'), '503 then success resolves with text')
  assert(calls === 3, `retried twice before success (calls=${calls})`)
  assert(dt >= 900, `backoff waited between retries (${dt}ms)`)
} catch (e) {
  assert(false, `503 should be retried, threw: ${e.message}`)
}

// 2. 401 -> throws immediately, single call.
calls = 0
globalThis.fetch = async () => {
  calls++
  return mkRes({ ok: false, status: 401, json: { error: { message: 'API key not valid.' } } })
}
try {
  await generateContent({ model: 'test-model', apiKey: 'bad', body: { contents: [] }, label: 'Gemini LLM' })
  assert(false, '401 should throw')
} catch (e) {
  assert(calls === 1, `401 not retried (calls=${calls})`)
  assert(/401|not valid/i.test(e.message), '401 error surfaced')
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
