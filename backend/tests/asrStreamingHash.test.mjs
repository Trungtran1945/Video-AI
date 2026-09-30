// Streaming hash: hashFileContent is async, uses createReadStream,
// never readFileSync whole-file. Hash matches SHA-256 of bytes.
// Run: node backend/tests/asrStreamingHash.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const { hashFileContent } = await import('../src/pipeline/sttUtils.js')

// 1. Source fence: no whole-file readFileSync in hashFileContent
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'sttUtils.js'), 'utf8')
  const fnBody = src.slice(src.indexOf('export async function hashFileContent'), src.indexOf('export async function hashFileContent') + 800)
  assert(fnBody.includes('createReadStream'), 'hashFileContent uses createReadStream')
  assert(!fnBody.includes('readFileSync'), 'hashFileContent has no readFileSync')
  assert(src.includes('export async function hashFileContent'), 'hashFileContent is async')
}

// 2. Hash correctness (small + larger file)
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-hash-'))
  const f1 = path.join(tmp, 'a.bin')
  const bytes = Buffer.from('hello whisper streaming hash')
  fs.writeFileSync(f1, bytes)
  const expected = crypto.createHash('sha256').update(bytes).digest('hex')
  const got = await hashFileContent(f1)
  assert(got === expected, 'streaming hash matches SHA-256 (small file)')

  const f2 = path.join(tmp, 'b.bin')
  const big = crypto.randomBytes(256 * 1024)
  fs.writeFileSync(f2, big)
  const expected2 = crypto.createHash('sha256').update(big).digest('hex')
  const got2 = await hashFileContent(f2)
  assert(got2 === expected2, 'streaming hash matches SHA-256 (256KB file)')

  // Different content → different hash
  const f3 = path.join(tmp, 'c.bin')
  fs.writeFileSync(f3, Buffer.from('different-bytes'))
  const got3 = await hashFileContent(f3)
  assert(got3 !== got, 'different bytes → different hash')
  fs.rmSync(tmp, { recursive: true, force: true })
}

// 3. Missing file rejects (not silent)
{
  let threw = false
  try {
    await hashFileContent(path.join(os.tmpdir(), `nope-${Date.now()}.bin`))
  } catch (_) { threw = true }
  assert(threw, 'missing file rejects')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
