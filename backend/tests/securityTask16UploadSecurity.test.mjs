import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { once } from 'node:events'
import { v4 as uuidv4 } from 'uuid'
import {
  FILE_SIZE_LIMITS,
  ALLOWED_EXTENSIONS_BY_TYPE,
  EXTENSION_MIME_MAP,
  isDangerousSignature,
  detectFileSignature,
  validateFileSignature,
  sanitizeStorageFilename,
  assertSafeUploadPath,
  cleanupTempFile,
  FileValidationError,
} from '../src/lib/fileValidation.js'

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL: ${name} ->`, err.message)
  }
}

async function asyncTest(name, fn) {
  try {
    await fn()
    console.log(`PASS: ${name}`)
  } catch (err) {
    failures++
    console.error(`FAIL: ${name} ->`, err)
  }
}

async function run() {
  console.log('\n--- SECTION 1: Dangerous Executable & Script Signature Detection ---')

  test('isDangerousSignature detects Windows PE / EXE / DLL (MZ magic bytes)', () => {
    const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
    const res = isDangerousSignature(exeBuf)
    assert.strictEqual(res.dangerous, true)
    assert(res.reason.includes('Windows executable'))
  })

  test('isDangerousSignature detects Linux ELF binaries', () => {
    const elfBuf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00])
    const res = isDangerousSignature(elfBuf)
    assert.strictEqual(res.dangerous, true)
    assert(res.reason.includes('Linux ELF'))
  })

  test('isDangerousSignature detects Mach-O binaries (macOS)', () => {
    // 0xFEEDFACE 32-bit big endian
    const macho32 = Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0x00, 0x00, 0x00, 0x00])
    const res32 = isDangerousSignature(macho32)
    assert.strictEqual(res32.dangerous, true)
    assert(res32.reason.includes('Mach-O'))

    // 0xFEEDFACF 64-bit
    const macho64 = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0x00, 0x00, 0x00, 0x00])
    const res64 = isDangerousSignature(macho64)
    assert.strictEqual(res64.dangerous, true)
  })

  test('isDangerousSignature detects Java class bytecode / universal binary', () => {
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34])
    const res = isDangerousSignature(javaClass)
    assert.strictEqual(res.dangerous, true)
    assert(res.reason.includes('Java class'))
  })

  test('isDangerousSignature detects shell script shebangs (#!/bin/sh, etc.)', () => {
    const shBuf = Buffer.from('#!/bin/bash\nrm -rf /', 'utf8')
    const res = isDangerousSignature(shBuf)
    assert.strictEqual(res.dangerous, true)
    assert(res.reason.includes('shebang'))
  })

  test('isDangerousSignature detects Windows shortcut files (.lnk)', () => {
    const lnkBuf = Buffer.from([0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])
    const res = isDangerousSignature(lnkBuf)
    assert.strictEqual(res.dangerous, true)
    assert(res.reason.includes('shortcut'))
  })

  test('isDangerousSignature detects embedded PHP scripts', () => {
    const php1 = Buffer.from('<?php phpinfo(); ?>', 'utf8')
    assert.strictEqual(isDangerousSignature(php1).dangerous, true)

    const php2 = Buffer.from('GIF89a<?php system($_GET["cmd"]); ?>', 'utf8')
    assert.strictEqual(isDangerousSignature(php2).dangerous, true)

    const phpShort = Buffer.from('<?= $flag ?>', 'utf8')
    assert.strictEqual(isDangerousSignature(phpShort).dangerous, true)
  })

  console.log('\n--- SECTION 2: Media Signature Detection (Magic Bytes) ---')

  test('detectFileSignature detects Video formats (MP4, MKV, MOV, WebM, AVI)', () => {
    // MP4 (ISOBMFF with ftyp)
    const mp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    const mp4Res = detectFileSignature(mp4)
    assert.strictEqual(mp4Res.type, 'video')
    assert.strictEqual(mp4Res.format, 'mp4')

    // MKV (EBML)
    const mkv = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81])
    const mkvRes = detectFileSignature(mkv)
    assert.strictEqual(mkvRes.type, 'video')
    assert.strictEqual(mkvRes.format, 'mkv')

    // WebM (EBML containing webm)
    const webm = Buffer.concat([
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
      Buffer.from('...docType: webm...', 'utf8'),
    ])
    const webmRes = detectFileSignature(webm)
    assert.strictEqual(webmRes.type, 'video')
    assert.strictEqual(webmRes.format, 'webm')

    // AVI (RIFF ... AVI )
    const avi = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20])
    const aviRes = detectFileSignature(avi)
    assert.strictEqual(aviRes.type, 'video')
    assert.strictEqual(aviRes.format, 'avi')
  })

  test('detectFileSignature detects Audio formats (MP3, WAV, AAC, M4A, FLAC, OGG)', () => {
    // MP3 (ID3v2)
    const mp3Id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00])
    assert.strictEqual(detectFileSignature(mp3Id3).type, 'audio')
    assert.strictEqual(detectFileSignature(mp3Id3).format, 'mp3')

    // MP3 (sync word FFFB)
    const mp3Sync = Buffer.from([0xff, 0xfb, 0x90, 0x44, 0x00])
    assert.strictEqual(detectFileSignature(mp3Sync).type, 'audio')
    assert.strictEqual(detectFileSignature(mp3Sync).format, 'mp3')

    // WAV (RIFF ... WAVE)
    const wav = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45])
    assert.strictEqual(detectFileSignature(wav).type, 'audio')
    assert.strictEqual(detectFileSignature(wav).format, 'wav')

    // AAC (ADTS sync word FFF1)
    const aac = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x00])
    assert.strictEqual(detectFileSignature(aac).type, 'audio')
    assert.strictEqual(detectFileSignature(aac).format, 'aac')

    // M4A (ftypM4A )
    const m4a = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20])
    assert.strictEqual(detectFileSignature(m4a).type, 'audio')
    assert.strictEqual(detectFileSignature(m4a).format, 'm4a')

    // FLAC (fLaC)
    const flac = Buffer.from([0x66, 0x4c, 0x61, 0x43, 0x00, 0x00])
    assert.strictEqual(detectFileSignature(flac).type, 'audio')
    assert.strictEqual(detectFileSignature(flac).format, 'flac')

    // OGG (OggS)
    const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02])
    assert.strictEqual(detectFileSignature(ogg).type, 'audio')
    assert.strictEqual(detectFileSignature(ogg).format, 'ogg')
  })

  test('detectFileSignature detects Image formats (PNG, JPEG, WebP, GIF, BMP, clean SVG)', () => {
    // PNG
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.strictEqual(detectFileSignature(png).type, 'image')
    assert.strictEqual(detectFileSignature(png).format, 'png')

    // JPEG
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    assert.strictEqual(detectFileSignature(jpeg).type, 'image')
    assert.strictEqual(detectFileSignature(jpeg).format, 'jpeg')

    // WebP (RIFF ... WEBP)
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])
    assert.strictEqual(detectFileSignature(webp).type, 'image')
    assert.strictEqual(detectFileSignature(webp).format, 'webp')

    // GIF (GIF89a)
    const gif = Buffer.from('GIF89a...', 'utf8')
    assert.strictEqual(detectFileSignature(gif).type, 'image')
    assert.strictEqual(detectFileSignature(gif).format, 'gif')

    // BMP (BM)
    const bmp = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00])
    assert.strictEqual(detectFileSignature(bmp).type, 'image')
    assert.strictEqual(detectFileSignature(bmp).format, 'bmp')

    // Clean SVG
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>', 'utf8')
    assert.strictEqual(detectFileSignature(svg).type, 'image')
    assert.strictEqual(detectFileSignature(svg).format, 'svg')
  })

  test('detectFileSignature rejects malicious SVG containing script tags or event handlers', () => {
    const maliciousSvg1 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8')
    const res1 = detectFileSignature(maliciousSvg1)
    assert.strictEqual(res1.dangerous, true)

    const maliciousSvg2 = Buffer.from('<svg onload="alert(1)"><circle/></svg>', 'utf8')
    const res2 = detectFileSignature(maliciousSvg2)
    assert.strictEqual(res2.dangerous, true)

    const maliciousSvg3 = Buffer.from('<svg><a href="javascript:alert(1)"><text>Click</text></a></svg>', 'utf8')
    const res3 = detectFileSignature(maliciousSvg3)
    assert.strictEqual(res3.dangerous, true)
  })

  test('detectFileSignature detects Subtitle formats (SRT, VTT, ASS)', () => {
    // SRT
    const srt = Buffer.from('1\r\n00:00:01,000 --> 00:00:04,000\r\nHello World\r\n\r\n', 'utf8')
    assert.strictEqual(detectFileSignature(srt).type, 'subtitle')
    assert.strictEqual(detectFileSignature(srt).format, 'srt')

    // VTT
    const vtt = Buffer.from('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:04.000\r\nHello', 'utf8')
    assert.strictEqual(detectFileSignature(vtt).type, 'subtitle')
    assert.strictEqual(detectFileSignature(vtt).format, 'vtt')

    // ASS
    const ass = Buffer.from('[Script Info]\r\nTitle: Default\r\n', 'utf8')
    assert.strictEqual(detectFileSignature(ass).type, 'subtitle')
    assert.strictEqual(detectFileSignature(ass).format, 'ass')
  })

  console.log('\n--- SECTION 3: File Signature Validation & Anti-Spoofing (validateFileSignature) ---')

  await asyncTest('validateFileSignature validates buffer directly for expected type and filename', async () => {
    const mp4Buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    const res = await validateFileSignature(mp4Buf, {
      expectedType: 'video',
      filename: 'sample.mp4',
    })
    assert.strictEqual(res.valid, true)
    assert.strictEqual(res.type, 'video')
    assert.strictEqual(res.format, 'mp4')
  })

  await asyncTest('validateFileSignature rejects spoofed extension (EXE disguised as .mp4)', async () => {
    const fakeVideo = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00])
    await assert.rejects(
      async () => {
        await validateFileSignature(fakeVideo, {
          expectedType: 'video',
          filename: 'cute_cat.mp4',
        })
      },
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 400)
        assert.strictEqual(err.code, 'MALICIOUS_FILE_DETECTED')
        return true
      }
    )
  })

  await asyncTest('validateFileSignature rejects media type mismatch (Audio uploaded as Video)', async () => {
    const mp3Buf = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00])
    await assert.rejects(
      async () => {
        await validateFileSignature(mp3Buf, {
          expectedType: 'video',
          filename: 'song.mp4',
        })
      },
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 415)
        assert.strictEqual(err.code, 'MEDIA_TYPE_MISMATCH')
        return true
      }
    )
  })

  await asyncTest('validateFileSignature rejects extension mismatch (PNG bytes named .mp3)', async () => {
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await assert.rejects(
      async () => {
        await validateFileSignature(pngBuf, {
          allowedTypes: ['image', 'audio'],
          filename: 'track.mp3',
        })
      },
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 415)
        assert.strictEqual(err.code, 'FILE_SIGNATURE_MISMATCH')
        return true
      }
    )
  })

  await asyncTest('validateFileSignature rejects files exceeding maxBytes limit', async () => {
    const largeBuf = Buffer.alloc(1024, 0x20)
    await assert.rejects(
      async () => {
        await validateFileSignature(largeBuf, {
          maxBytes: 512,
        })
      },
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 413)
        assert.strictEqual(err.code, 'PAYLOAD_TOO_LARGE')
        return true
      }
    )
  })

  await asyncTest('validateFileSignature rejects empty files', async () => {
    const emptyBuf = Buffer.alloc(0)
    await assert.rejects(
      async () => {
        await validateFileSignature(emptyBuf)
      },
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 400)
        assert.strictEqual(err.code, 'EMPTY_FILE')
        return true
      }
    )
  })

  console.log('\n--- SECTION 4: Storage Filename Sanitization & Path Traversal Prevention ---')

  test('sanitizeStorageFilename strips path traversal sequences and generates safe UUID keys', () => {
    const badNames = [
      '../../etc/passwd',
      '..\\..\\windows\\system32\\cmd.exe',
      '..%2f..%2fconfig.json',
      'foo/bar/video.mp4',
      'my-video\x00.mp4',
    ]

    for (const bad of badNames) {
      const sanitized = sanitizeStorageFilename(bad, { prefix: 'uploads', defaultExt: '.dat' })
      assert(!sanitized.includes('..'), `No double dot traversal in ${sanitized}`)
      assert(!sanitized.includes('/etc/'), `No etc path in ${sanitized}`)
      assert(!sanitized.includes('system32'), `No system32 in ${sanitized}`)
      assert(!sanitized.includes('\x00'), `No null byte in ${sanitized}`)
      assert(/^uploads\/[0-9a-f-]{36}\.[a-z0-9]+$/i.test(sanitized), `Valid UUID key format: ${sanitized}`)
    }
  })

  test('assertSafeUploadPath enforces strict filesystem containment', () => {
    const baseDir = path.resolve('storage')
    const safePath = path.resolve('storage', 'uploads', 'valid.mp4')
    assert.strictEqual(assertSafeUploadPath(baseDir, safePath), true)

    const unsafePath = path.resolve('storage', '..', 'etc', 'passwd')
    assert.throws(
      () => assertSafeUploadPath(baseDir, unsafePath),
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 409)
        assert.strictEqual(err.code, 'UPLOAD_PATH_UNSAFE')
        return true
      }
    )

    const nullByteEsc = path.join(baseDir, 'uploads\x00', 'bad.mp4')
    assert.throws(
      () => assertSafeUploadPath(baseDir, nullByteEsc),
      (err) => {
        assert(err instanceof FileValidationError)
        assert.strictEqual(err.statusCode, 400)
        return true
      }
    )
  })

  await asyncTest('cleanupTempFile removes existing temp files safely and ignores missing files', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-cleanup-${uuidv4()}.tmp`)
    fs.writeFileSync(tmpFile, 'test data')
    assert(fs.existsSync(tmpFile))

    await cleanupTempFile(tmpFile)
    assert(!fs.existsSync(tmpFile), 'Temp file was unlinked')

    // Calling cleanup on already deleted file should not throw
    await cleanupTempFile(tmpFile)
  })

  console.log('\n--- SECTION 5: End-to-End Upload Security Verification ---')

  await asyncTest('Integration: composer upload rejects disguised executable with 400', async () => {
    const { initSchema } = await import('../src/db/schema.js')
    const { insert } = await import('../src/db/query.js')
    const { generateAccessToken } = await import('../src/middleware/auth.js')
    const composerAssetsRouter = (await import('../src/routes/v1/composerAssets.js')).default

    await initSchema()
    const testUser = { id: 'user-sec16-' + uuidv4().slice(0, 8), email: 'sec16@test.local', role: 'user' }
    await insert('users', { id: testUser.id, email: testUser.email, role: 'user', password: 'hash' })
    const token = generateAccessToken(testUser)

    const testProject = {
      id: 'proj-sec16-' + uuidv4().slice(0, 8),
      user_id: testUser.id,
      title: 'Upload Security Project',
      mode: 'MEDIA_COMPOSER',
      status: 'queued',
    }
    await insert('projects', testProject)

    const app = express()
    app.use('/api/v1/projects', composerAssetsRouter)
    const server = app.listen(0)
    await once(server, 'listening')
    const port = server.address().port

    try {
      // 1. Upload disguised executable (MZ header disguised as cute_cat.jpg)
      const boundary = '----BoundarySecTest' + Math.random().toString(36).slice(2)
      const fakeExePayload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="cute_cat.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]), // Windows executable header!
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])

      const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${testProject.id}/assets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: fakeExePayload,
      })

      assert.strictEqual(res.status, 400, 'Disguised executable is rejected with 400')
      const body = await res.json()
      assert.strictEqual(body.error?.code, 'UNSUPPORTED_MEDIA_TYPE')

      // 2. Upload legitimate PNG
      const boundary2 = '----BoundarySecTest2' + Math.random().toString(36).slice(2)
      const validPngPayload = Buffer.concat([
        Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nimage\r\n`),
        Buffer.from(`--${boundary2}\r\nContent-Disposition: form-data; name="files"; filename="real_image.png"\r\nContent-Type: image/png\r\n\r\n`),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
        Buffer.from(`\r\n--${boundary2}--\r\n`),
      ])

      const res2 = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${testProject.id}/assets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary2}`,
        },
        body: validPngPayload,
      })

      assert.strictEqual(res2.status, 200, 'Legitimate PNG upload succeeds with 200')
      const body2 = await res2.json()
      assert(Array.isArray(body2.assets) && body2.assets.length === 1)
      assert.strictEqual(body2.assets[0].name, 'real_image.png')
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve)).catch(() => {})
      try {
        const { query: runQuery } = await import('../src/db/query.js')
        await runQuery('DELETE FROM projects WHERE id = ?', [testProject.id])
        await runQuery('DELETE FROM users WHERE id = ?', [testUser.id])
      } catch (_) {}
    }
  })

  // Cleanup queues and connections
  try {
    const { connection } = await import('../src/queue/connection.js')
    try { connection.disconnect() } catch (_) {}
    const { projectQueue } = await import('../src/queue/projectQueue.js')
    const { drainQueue } = await import('../src/queue/drainQueue.js')
    const { notifyQueue } = await import('../src/queue/notifyQueue.js')
    const { cleanupQueue } = await import('../src/queue/cleanupQueue.js')
    await Promise.all([projectQueue.close(), drainQueue.close(), notifyQueue.close(), cleanupQueue.close()].map((p) => p.catch(() => {})))
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200))

  console.log(`\n========================================`)
  if (failures === 0) {
    console.log('ALL SECURITY TASK 16 TESTS PASSED!')
    console.log('========================================\n')
    process.exit(0)
  } else {
    console.error(`TOTAL FAILURES: ${failures}`)
    console.log('========================================\n')
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
