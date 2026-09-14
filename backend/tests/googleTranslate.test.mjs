// TDD: Google Translate provider — 404 is CONFIGURATION (no blind retry,
// diagnostic endpoint info, never secrets); 503 is retried; missing URL errors fast.
// Run: node backend/tests/googleTranslate.test.mjs
import { GoogleTranslate } from '../src/providers/translate/googleTranslate.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const realFetch = globalThis.fetch
const mkRes = ({ ok, status, json }) => ({ ok, status, json: async () => json })

// 1. Missing script URL -> fast configuration error mentioning the env var.
try {
  await new GoogleTranslate('').translate('hello', 'en', 'vi')
  assert(false, 'missing URL should throw')
} catch (e) {
  assert(e.kind === 'CONFIGURATION', 'missing URL -> CONFIGURATION kind')
  assert(/GOOGLE_TRANSLATE_SCRIPT_URL/.test(e.message), 'missing URL mentions env var')
}

// 2. HTTP 404 -> CONFIGURATION, NO retry, diagnostic endpoint without secrets.
let calls = 0
globalThis.fetch = async () => { calls++; return mkRes({ ok: false, status: 404, json: {} }) }
try {
  await new GoogleTranslate('https://script.google.com/macros/s/ABC123/exec').translate('secret text here', 'en', 'vi')
  assert(false, '404 should throw')
} catch (e) {
  assert(calls === 1, `404 not retried (calls=${calls})`)
  assert(e.kind === 'CONFIGURATION', '404 -> CONFIGURATION kind')
  assert(e.status === 404, '404 status preserved')
  assert(typeof e.endpoint === 'string' && e.endpoint.includes('script.google.com'), 'diagnostic endpoint host logged')
  assert(!String(e.endpoint).includes('secret'), 'endpoint diagnostic leaks no query/text')
  assert(typeof e.hint === 'string' && e.hint.length > 0, 'actionable hint provided')
}

// 3. HTTP 503 -> retried, then success.
calls = 0
globalThis.fetch = async () => {
  calls++
  if (calls < 3) return mkRes({ ok: false, status: 503, json: {} })
  return mkRes({ ok: true, status: 200, json: { status: 'success', translatedText: 'Xin chào' } })
}
try {
  const out = await new GoogleTranslate('https://script.google.com/macros/s/ABC123/exec').translate('hello', 'en', 'vi')
  assert(out === 'Xin chào', '503 retried then success')
  assert(calls === 3, `503 retried (calls=${calls})`)
} catch (e) {
  assert(false, `503 should be retried: ${e.message}`)
}

globalThis.fetch = realFetch
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
