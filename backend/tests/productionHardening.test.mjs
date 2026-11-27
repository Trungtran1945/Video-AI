// Production Hardening Verification Suite (M1 — runs cleanly without live PostgreSQL/Redis)
// Covers: ARCH-001..003, ARCH-007, ARCH-008, ARCH-012, SEC-001..003, SEC-005, SEC-007..009
// Run: node backend/tests/productionHardening.test.mjs
process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const backendRoot = path.join(__dirname, '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-prod-hardening-'))

let failures = 0
async function runTest(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    failures += 1
    console.error(`FAIL: ${name} -> ${err?.stack || err}`)
  }
}

// 1. ARCH-001: ffmpeg concurrency queue & non-blocking probe
await runTest('ARCH-001: getFfmpegConcurrency & createConcurrencyQueue enforce platform limits', async () => {
  const { getFfmpegConcurrency, createConcurrencyQueue } = await import('../src/media/ffmpeg.js')
  assert.equal(getFfmpegConcurrency('win32', '4'), 1, 'win32 always serializes ffmpeg to 1')
  assert.equal(getFfmpegConcurrency('linux', undefined), 2, 'linux defaults to 2')
  assert.equal(getFfmpegConcurrency('linux', '3'), 3, 'linux honors FFMPEG_CONCURRENCY=3')

  const queue = createConcurrencyQueue(() => 2)
  let current = 0
  let maxObserved = 0
  await Promise.all([1, 2, 3, 4].map(() => queue(async () => {
    current += 1
    maxObserved = Math.max(maxObserved, current)
    await new Promise((r) => setTimeout(r, 25))
    current -= 1
  })))
  assert.equal(maxObserved, 2, `bounded queue peaked at 2 concurrent tasks (got ${maxObserved})`)

  const ffmpegSrc = fs.readFileSync(path.join(backendRoot, 'src', 'media', 'ffmpeg.js'), 'utf8')
  const probeFn = ffmpegSrc.slice(ffmpegSrc.indexOf('export async function probe'))
  assert.ok(!probeFn.includes('enqueueFfmpeg'), 'probe() does not queue behind ffmpeg encodes')
  assert.ok(ffmpegSrc.includes('DEFAULT_PROBE_TIMEOUT_MS'), 'probe() enforces a default timeout')
})

// 2. ARCH-002 & ARCH-003: outputService uploads outside withTransaction, cleans up orphans, and returns Cloudinary metadata
await runTest('ARCH-002 & ARCH-003: createOutput uploads via uploadLarge before withTransaction and cleans up on conflict', async () => {
  const { createOutput, OutputRunConflict } = await import('../src/services/outputService.js')
  const { config } = await import('../src/config.js')

  const outRelKey = 'outputs/test-hardening-video.mp4'
  const thumbRelKey = 'outputs/thumbs/test-hardening-thumb.jpg'
  const outAbs = path.join(config.storageDir, outRelKey)
  const thumbAbs = path.join(config.storageDir, thumbRelKey)
  fs.mkdirSync(path.dirname(outAbs), { recursive: true })
  fs.mkdirSync(path.dirname(thumbAbs), { recursive: true })
  fs.writeFileSync(outAbs, Buffer.from('video-bytes'))
  fs.writeFileSync(thumbAbs, Buffer.from('thumb-bytes'))

  try {
    const events = []
    const deletedAssets = []
    const mockStorage = {
      async uploadLarge(_file, opts) {
        events.push('uploadLarge:' + opts.key)
        return {
          provider: 'cloudinary',
          assetId: 'asset-1',
          publicId: 'video_ai/outputs/test-hardening-video',
          secureUrl: 'https://res.cloudinary.com/demo/video/upload/test.mp4',
          resourceType: 'video',
          format: 'mp4',
          bytes: 11,
        }
      },
      async upload(_file, opts) {
        events.push('upload:' + opts.key)
        return {
          provider: 'cloudinary',
          assetId: 'thumb-1',
          publicId: 'video_ai/outputs/thumbs/test-hardening-thumb',
          secureUrl: 'https://res.cloudinary.com/demo/image/upload/test.jpg',
          resourceType: 'image',
          format: 'jpg',
          bytes: 11,
        }
      },
      async delete(publicId) {
        deletedAssets.push(publicId)
        return { success: true }
      },
    }

    let txCalls = 0
    const insertedRows = []
    const mockReadDb = {
      async queryOne(sql) {
        if (sql.includes('FROM projects')) {
          return { id: 'p-1', mode: 'SUMMARY', status: 'running', run_token: 'tok-1', params: '{}' }
        }
        return null
      },
    }
    const mockWithTx = async (fn) => {
      txCalls += 1
      events.push('enterTx')
      const tx = {
        queryOne: mockReadDb.queryOne,
        async insert(table, row) {
          insertedRows.push({ table, row })
          return row
        },
      }
      return fn(tx)
    }

    const created = await createOutput(
      { id: 'out-1', projectId: 'p-1', storageKey: outRelKey, thumbnailKey: thumbRelKey, durationSec: 5, runToken: 'tok-1' },
      null,
      { storage: mockStorage, withTransaction: mockWithTx, db: mockReadDb }
    )

    assert.equal(txCalls, 1)
    assert.ok(events.indexOf('uploadLarge:' + outRelKey) < events.indexOf('enterTx'), 'uploadLarge runs BEFORE entering withTransaction')
    assert.ok(events.indexOf('upload:' + thumbRelKey) < events.indexOf('enterTx'), 'thumbnail upload runs BEFORE entering withTransaction')
    assert.equal(created.secure_url, 'https://res.cloudinary.com/demo/video/upload/test.mp4')
    assert.equal(created.thumbnail_secure_url, 'https://res.cloudinary.com/demo/image/upload/test.jpg')

    // Conflict inside TX must clean up orphaned Cloudinary uploads
    let conflictErr = null
    try {
      await createOutput(
        { id: 'out-2', projectId: 'p-1', storageKey: outRelKey, thumbnailKey: thumbRelKey, durationSec: 5, runToken: 'tok-1' },
        null,
        {
          storage: mockStorage,
          db: mockReadDb,
          withTransaction: async (fn) => fn({
            async queryOne(sql) {
              if (sql.includes('status, run_token')) return { status: 'cancelled', run_token: 'other' }
              return { id: 'p-1', mode: 'SUMMARY', params: '{}' }
            },
            async insert() { return {} },
          }),
        }
      )
    } catch (e) {
      conflictErr = e
    }
    assert.ok(conflictErr instanceof OutputRunConflict, 'OutputRunConflict thrown when run token changes before commit')
    assert.equal(deletedAssets.length, 2, 'Orphaned video & thumbnail Cloudinary assets cleaned up on OutputRunConflict')

    const outputSvcSrc = fs.readFileSync(path.join(backendRoot, 'src', 'services', 'outputService.js'), 'utf8')
    assert.ok(outputSvcSrc.includes('o.secure_url AS output_secure_url'), 'getOutputState selects output secure_url')
    assert.ok(outputSvcSrc.includes('thumbnailUrl:'), 'getOutputState computes thumbnailUrl')
  } finally {
    fs.rmSync(outAbs, { force: true })
    fs.rmSync(thumbAbs, { force: true })
  }
})

// 3. ARCH-007 & SEC-007: httpsEnforcementMiddleware host validation
await runTest('SEC-007: httpsEnforcementMiddleware rejects untrusted Host header when APP_DOMAIN is set', async () => {
  const { httpsEnforcementMiddleware, resolveSafeRedirectHost } = await import('../src/middleware/securityHeaders.js')
  const origDomain = process.env.APP_DOMAIN
  process.env.APP_DOMAIN = 'app.example.com'
  try {
    assert.equal(resolveSafeRedirectHost('evil.attacker.com'), 'app.example.com')
    assert.equal(resolveSafeRedirectHost('app.example.com'), 'app.example.com')

    const app = express()
    app.use(httpsEnforcementMiddleware({ forceHttps: true }))
    app.get('/ping', (_req, res) => res.json({ ok: true }))
    const server = app.listen(0)
    await once(server, 'listening')
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ping?a=1`, {
        redirect: 'manual',
        headers: { Host: 'evil.attacker.com' },
      })
      assert.equal(res.status, 301)
      assert.equal(res.headers.get('location'), 'https://app.example.com/ping?a=1')
    } finally {
      server.closeAllConnections?.()
      await new Promise((r) => server.close(r))
    }
  } finally {
    if (origDomain !== undefined) process.env.APP_DOMAIN = origDomain
    else delete process.env.APP_DOMAIN
  }
})

// 4. ARCH-008: Provider fetch timeouts & PROVIDER_TIMEOUT classification
await runTest('ARCH-008: Providers enforce AbortSignal timeout and classify AbortError as PROVIDER_TIMEOUT', async () => {
  const realFetch = globalThis.fetch
  const origTimeout = process.env.GOOGLE_TRANSLATE_TIMEOUT_MS
  const origOpenAiTimeout = process.env.OPENAI_TIMEOUT_MS
  process.env.GOOGLE_TRANSLATE_TIMEOUT_MS = '30'
  process.env.OPENAI_TIMEOUT_MS = '30'
  globalThis.fetch = (_url, opts = {}) => new Promise((_resolve, reject) => {
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      }, { once: true })
    }
  })

  try {
    const { GoogleTranslate } = await import('../src/providers/translate/googleTranslate.js')
    let gtErr = null
    try {
      await new GoogleTranslate('https://script.google.com/macros/s/TEST/exec').translate('hello', 'en', 'vi')
    } catch (e) { gtErr = e }
    assert.equal(gtErr?.code, 'PROVIDER_TIMEOUT', `GoogleTranslate timeout code (got ${gtErr?.code})`)

    const { OpenAiLlm } = await import('../src/providers/llm/openai.js')
    let aiErr = null
    try {
      await new OpenAiLlm('sk-test').complete({ prompt: 'hi' })
    } catch (e) { aiErr = e }
    assert.equal(aiErr?.code, 'PROVIDER_TIMEOUT', `OpenAiLlm timeout code (got ${aiErr?.code})`)
  } finally {
    globalThis.fetch = realFetch
    if (origTimeout !== undefined) process.env.GOOGLE_TRANSLATE_TIMEOUT_MS = origTimeout
    else delete process.env.GOOGLE_TRANSLATE_TIMEOUT_MS
    if (origOpenAiTimeout !== undefined) process.env.OPENAI_TIMEOUT_MS = origOpenAiTimeout
    else delete process.env.OPENAI_TIMEOUT_MS
  }
})

// 5. SEC-001: sourceVideoKey, mediaStaging, and Cloudinary URL SSRF guards
await runTest('SEC-001: Blocks arbitrary file read and SSRF in staging & sourceVideoKey validation', async () => {
  const { isValidSourceVideoKey } = await import('../src/routes/v1/projects.js')
  assert.equal(isValidSourceVideoKey('/etc/passwd'), false)
  assert.equal(isValidSourceVideoKey('uploads/../../../etc/passwd.mp4'), false)
  assert.equal(isValidSourceVideoKey('http://169.254.169.254/latest.mp4'), false)
  assert.equal(isValidSourceVideoKey('uploads/x.mp4', { nodeEnv: 'production', hasOwnedSession: false }), false)
  assert.equal(isValidSourceVideoKey('uploads/550e8400-e29b-41d4-a716-446655440000.mp4', { nodeEnv: 'production', hasOwnedSession: false }), true)
  assert.equal(isValidSourceVideoKey('uploads/x.mp4', { nodeEnv: 'test', hasOwnedSession: false }), true)

  const { assertSafeRemoteMediaUrl } = await import('../src/services/storage/cloudinaryStorageProvider.js')
  assert.throws(() => assertSafeRemoteMediaUrl('http://169.254.169.254/latest/meta-data'))
  assert.throws(() => assertSafeRemoteMediaUrl('https://127.0.0.1/video.mp4'))
  assert.throws(() => assertSafeRemoteMediaUrl('http://res.cloudinary.com/demo/video/upload/x.mp4'))
  assert.throws(() => assertSafeRemoteMediaUrl('https://evil.com/x.mp4'))
  assert.ok(assertSafeRemoteMediaUrl('https://res.cloudinary.com/demo/video/upload/sample.mp4').startsWith('https://res.cloudinary.com/'))

  const { createJobStagingContext } = await import('../src/pipeline/mediaStaging.js')
  const outsideFile = path.join(tmpRoot, 'outside.mp4')
  fs.writeFileSync(outsideFile, 'secret')
  const stageCtx = createJobStagingContext('p-sec1', 'dub.ingest', { storageDir: path.join(tmpRoot, 'storage') })
  await assert.rejects(() => stageCtx.stageFile(outsideFile), /Unsafe media staging path/)
  await assert.rejects(() => stageCtx.stageFile('http://169.254.169.254/latest/meta-data'), /Unsafe remote media/)
})

// 6. SEC-002 & SEC-003: getClientIp ignores forged XFF & v1Router rate limiters
await runTest('SEC-002 & SEC-003: getClientIp ignores forged XFF[0] and globalApiRateLimiter is mounted on v1Router', async () => {
  const { getClientIp } = await import('../src/middleware/rateLimiter.js')
  const spoofedReq = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.77, 203.0.113.9' } }
  assert.equal(getClientIp(spoofedReq), '203.0.113.9')

  const v1Src = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'v1', 'index.js'), 'utf8')
  assert.ok(v1Src.includes('router.use(globalApiRateLimiter)'), 'v1Router mounts globalApiRateLimiter')
  assert.ok(v1Src.includes('uploadRateLimiter'), 'v1Router mounts uploadRateLimiter')
  assert.ok(v1Src.includes('chunkUploadRateLimiter'), 'v1Router mounts chunkUploadRateLimiter')
})

// 7. SEC-005 & SEC-009: Production /health & /ready strip internal errors + /app/ redaction
await runTest('SEC-005 & SEC-009: sanitizeStringContent redacts /app/ paths and prod /health hides lastSaveError', async () => {
  const { sanitizeStringContent } = await import('../src/lib/responseSanitizer.js')
  assert.equal(sanitizeStringContent('Error at /app/src/db.js:12'), 'Error at [internal path]:12')
  assert.equal(sanitizeStringContent('/api/v1/projects'), '/api/v1/projects')

  const healthSrc = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'v1', 'health.js'), 'utf8')
  assert.ok(!healthSrc.includes('lastSaveError:'), 'health.js does not return raw lastSaveError on public endpoints')
  assert.ok(healthSrc.includes("process.env.NODE_ENV === 'production'"), 'health.js minimizes operational telemetry in production')
})

// 8. SEC-008: Full SVG XSS scan beyond 512 bytes
await runTest('SEC-008: Rejects SVG with script/event handler past 512 bytes in validateFileSignature and checkMediaSignature', async () => {
  const { validateFileSignature } = await import('../src/lib/fileValidation.js')
  const { checkMediaSignature } = await import('../src/routes/v1/composerAssets.js')

  const padding = '<!-- ' + 'A'.repeat(700) + ' -->'
  const paddedEvilSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${padding}<script>alert(1)</script></svg>`, 'utf8')
  const paddedCleanSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${padding}<rect width="10" height="10"/></svg>`, 'utf8')

  await assert.rejects(
    () => validateFileSignature(paddedEvilSvg, { allowedTypes: ['image'], filename: 'evil.svg' }),
    /Dangerous|MALICIOUS_FILE_DETECTED/
  )
  const cleanRes = await validateFileSignature(paddedCleanSvg, { allowedTypes: ['image'], filename: 'clean.svg' })
  assert.equal(cleanRes.format, 'svg')

  const evilSvgPath = path.join(tmpRoot, 'padded-evil.svg')
  const cleanSvgPath = path.join(tmpRoot, 'padded-clean.svg')
  fs.writeFileSync(evilSvgPath, paddedEvilSvg)
  fs.writeFileSync(cleanSvgPath, paddedCleanSvg)
  assert.equal(checkMediaSignature(evilSvgPath), false, 'checkMediaSignature rejects >512B padded evil SVG')
  assert.equal(checkMediaSignature(cleanSvgPath), true, 'checkMediaSignature accepts >512B clean SVG')
})

// 9. ARCH-012 & ARCH-013: projects sortBy updated_date/updated_at & server.js fallback cleanup
await runTest('ARCH-012 & ARCH-013: projects.js maps updated_date -> updated_at and server.js runs fallback cleanup', async () => {
  const projectsSrc = fs.readFileSync(path.join(backendRoot, 'src', 'routes', 'v1', 'projects.js'), 'utf8')
  assert.ok(projectsSrc.includes("'updated_at'"), 'projects.js allowlist includes updated_at')
  assert.ok(projectsSrc.includes("req.query.sortBy === 'updated_date' ? 'updated_at'"), 'projects.js safely maps legacy updated_date to updated_at')

  const serverSrc = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8')
  assert.ok(serverSrc.includes('startFallbackCleanupLoop'), 'server.js defines startFallbackCleanupLoop when Redis is unavailable')
})

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PRODUCTION HARDENING TESTS PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
