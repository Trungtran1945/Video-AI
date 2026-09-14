// TDD: provider error classification (TRANSIENT / PERMANENT / CONFIGURATION / INVALID_RESPONSE).
// Run: node backend/tests/providerErrors.test.mjs
import { classifyProviderError } from '../src/lib/providerErrors.js'

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

const e503 = classifyProviderError(new Error('Gemini LLM error: This model is currently experiencing high demand.'))
assert(e503.kind === 'TRANSIENT' && e503.retryable === true, '503/high-demand -> TRANSIENT retryable')

const http503 = classifyProviderError(Object.assign(new Error('Gemini HTTP 503'), { status: 503 }))
assert(http503.kind === 'TRANSIENT' && http503.retryable === true, 'HTTP 503 -> TRANSIENT retryable')

const e429 = classifyProviderError(Object.assign(new Error('rate limit exceeded, retry in 5s'), { status: 429 }))
assert(e429.kind === 'TRANSIENT' && e429.retryable === true, '429 -> TRANSIENT retryable')

const timeout = classifyProviderError(Object.assign(new Error('fetch failed: timeout'), { code: 'ETIMEDOUT' }))
assert(timeout.kind === 'TRANSIENT' && timeout.retryable === true, 'timeout -> TRANSIENT retryable')

const e401 = classifyProviderError(Object.assign(new Error('Gemini HTTP 401'), { status: 401 }))
assert(e401.kind === 'PERMANENT' && e401.retryable === false, '401 -> PERMANENT non-retryable')

const e403 = classifyProviderError(Object.assign(new Error('invalid credentials'), { status: 403 }))
assert(e403.kind === 'PERMANENT' && e403.retryable === false, '403 -> PERMANENT non-retryable')

const e404 = classifyProviderError(new Error('Google Translate HTTP 404'))
assert(e404.kind === 'CONFIGURATION' && e404.retryable === false, '404 -> CONFIGURATION non-retryable (diagnostic)')

const badJson = classifyProviderError(new SyntaxError('Unexpected token < in JSON at position 0'))
assert(badJson.kind === 'INVALID_RESPONSE' && badJson.retryable === false, 'malformed JSON -> INVALID_RESPONSE')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
