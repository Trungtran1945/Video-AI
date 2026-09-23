// CORS allowlist + JSON body limit regression.
// Run: node backend/tests/corsAllowlist.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { isOriginAllowed, config } = await import('../src/config.js')

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

// 1. Same-origin / non-browser (no Origin header) allowed.
assert(isOriginAllowed(null) === true, 'null origin allowed')
assert(isOriginAllowed(undefined) === true, 'undefined origin allowed')
assert(isOriginAllowed('') === true, 'empty origin allowed')

// 2. Allowlisted origins allowed, others rejected.
assert(isOriginAllowed('http://localhost:5173') === true || config.nodeEnv === 'production',
  'dev default allows vite origin (non-production)')
assert(isOriginAllowed('https://evil.example.com') === false, 'unknown origin rejected')
assert(isOriginAllowed('https://evil.example.com', { nodeEnv: 'production', corsOrigins: ['https://app.example.com'] }) === false,
  'production rejects non-allowlisted origin')
assert(isOriginAllowed('https://app.example.com', { nodeEnv: 'production', corsOrigins: ['https://app.example.com'] }) === true,
  'production allows allowlisted origin')
assert(isOriginAllowed('https://a.example.com', { nodeEnv: 'production', corsOrigins: ['https://a.example.com', 'https://b.example.com'] }) === true,
  'comma-separated allowlist supports multiple origins')

// 3. No wildcard in production when API has auth.
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(!/^app\.use\(cors\(\)\)/m.test(serverSrc), 'server.js no longer uses bare cors()')
  assert(serverSrc.includes('isOriginAllowed'), 'server.js gates origin via isOriginAllowed')
  assert(!serverSrc.includes("origin: '*'") && !serverSrc.includes('origin: "*"'),
    'server.js has no wildcard origin')
}

// 4. Global JSON limit is tight (1MB), not 2GB.
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  assert(!serverSrc.includes("'2gb'") && !serverSrc.includes('"2gb"'), 'no 2GB JSON limit remains')
  assert(/express\.json\(\{\s*limit:\s*'1mb'\s*\}\)/.test(serverSrc), 'global JSON limit is 1mb')
}

// 5. Large video upload flow untouched (multipart + raw chunk endpoints).
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const uploadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'v1', 'upload.js'), 'utf8')
  assert(uploadSrc.includes('multer'), 'legacy multipart upload preserved')
  assert(uploadSrc.includes("express.raw({ type: 'application/octet-stream', limit: '16mb' })"),
    'resumable chunk endpoint keeps 16mb raw limit')
  assert(uploadSrc.includes('MAX_SIZE = 2 * 1024 * 1024 * 1024'), 'resumable max size still 2GB')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
