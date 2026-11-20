import assert from 'node:assert'
import express from 'express'
import { once } from 'node:events'
import {
  escapeHtml,
  unescapeHtml,
  sanitizeUrl,
  sanitizeSubtitleText,
  sanitizeErrorMessage,
} from '../src/lib/xssSanitizer.js'
import { sendError } from '../src/lib/httpError.js'
import { toAss } from '../src/pipeline/stages/scriptSubtitle.js'
import { toSrt } from '../src/pipeline/stages/summarySubtitle.js'

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
  console.log('\n--- SECTION 1: HTML Escaping & Entity Encoding ---')

  test('escapeHtml encodes script tags and HTML injection vectors', () => {
    assert.strictEqual(
      escapeHtml('<script>alert(1)</script>'),
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    )
    assert.strictEqual(
      escapeHtml('"><img src=x onerror=alert(1)>'),
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'
    )
    assert.strictEqual(
      escapeHtml("Hello 'world' & \"friends\""),
      'Hello &#39;world&#39; &amp; &quot;friends&quot;'
    )
  })

  test('escapeHtml handles null, undefined, numbers, and objects safely', () => {
    assert.strictEqual(escapeHtml(null), '')
    assert.strictEqual(escapeHtml(undefined), '')
    assert.strictEqual(escapeHtml(12345), '12345')
    assert.strictEqual(escapeHtml(false), 'false')
  })

  test('unescapeHtml correctly decodes escaped entities', () => {
    const raw = '<div class="alert" id=\'x\'>Fish & Chips</div>'
    const escaped = escapeHtml(raw)
    assert.strictEqual(unescapeHtml(escaped), raw)
  })

  console.log('\n--- SECTION 2: URL Sanitization & Protocol Validation ---')

  test('sanitizeUrl rejects dangerous pseudo-protocols and payload schemes', () => {
    const dangerousUrls = [
      'javascript:alert(1)',
      'javascript:void(0)',
      'JaVaScRiPt:alert(document.cookie)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox("XSS")',
      'file:///etc/passwd',
      'file://C:\\Windows\\win.ini',
      'blob:https://evil.com/uuid',
      '//evil.com/phishing',
      '/\\evil.com/phishing',
      '\\\\evil.com\\share',
    ]

    for (const url of dangerousUrls) {
      assert.strictEqual(sanitizeUrl(url), '', `Should reject dangerous URL: ${url}`)
    }
  })

  test('sanitizeUrl rejects protocol evasion via control characters and whitespace', () => {
    const evasionUrls = [
      'java\0script:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'java\rscript:alert(1)',
      ' javascript:alert(1)',
      'j a v a s c r i p t :alert(1)',
    ]

    for (const url of evasionUrls) {
      assert.strictEqual(sanitizeUrl(url), '', `Should reject evasion URL: ${JSON.stringify(url)}`)
    }
  })

  test('sanitizeUrl permits legitimate HTTP, HTTPS, and safe relative URLs', () => {
    assert.strictEqual(
      sanitizeUrl('https://example.com/video.mp4'),
      'https://example.com/video.mp4'
    )
    assert.strictEqual(
      sanitizeUrl('http://localhost:3001/api/v1/outputs'),
      'http://localhost:3001/api/v1/outputs'
    )
    assert.strictEqual(
      sanitizeUrl('https://sub.domain.com:8443/path?query=val#hash'),
      'https://sub.domain.com:8443/path?query=val#hash'
    )
    assert.strictEqual(
      sanitizeUrl('/storage/projects/video.mp4'),
      '/storage/projects/video.mp4'
    )
    assert.strictEqual(
      sanitizeUrl('/api/v1/health'),
      '/api/v1/health'
    )
  })

  console.log('\n--- SECTION 3: Subtitle Sanitization (ASS and SRT/VTT) ---')

  test('sanitizeSubtitleText for ASS format escapes override tags and control chars', () => {
    const assInjections = [
      '{\\pos(100,200)}Injected position',
      '{\\clip(0,0,1920,1080)}Injected clip',
      'Normal text with {curly braces} inside',
      'Line 1\nLine 2 with \\backslash\\',
    ]

    const s1 = sanitizeSubtitleText(assInjections[0], 'ass')
    assert.strictEqual(s1, '\\{\\\\pos(100,200)\\}Injected position')

    const s2 = sanitizeSubtitleText(assInjections[1], 'ass')
    assert.strictEqual(s2, '\\{\\\\clip(0,0,1920,1080)\\}Injected clip')

    const s3 = sanitizeSubtitleText(assInjections[2], 'ass')
    assert.strictEqual(s3, 'Normal text with \\{curly braces\\} inside')

    const s4 = sanitizeSubtitleText(assInjections[3], 'ass')
    assert.strictEqual(s4, 'Line 1\\NLine 2 with \\\\backslash\\\\')
  })

  test('sanitizeSubtitleText for SRT format neutralizes HTML/script while keeping formatting', () => {
    const srtScript = '<script>alert("xss")</script>Hello world!'
    assert.strictEqual(sanitizeSubtitleText(srtScript, 'srt'), 'Hello world!')

    const srtIframe = '<iframe src="http://evil.com"></iframe>Welcome'
    assert.strictEqual(sanitizeSubtitleText(srtIframe, 'srt'), 'Welcome')

    const srtImg = '<img src=x onerror=alert(1)>Text here'
    assert.strictEqual(sanitizeSubtitleText(srtImg, 'srt'), '&lt;img src=x&gt;Text here')

    // Safe formatting tags preserved
    const srtFormatting = '<b>In đậm</b>, <i>in nghiêng</i>, và <u>gạch chân</u>'
    assert.strictEqual(sanitizeSubtitleText(srtFormatting, 'srt'), srtFormatting)
  })

  test('sanitizeSubtitleText preserves 100% Vietnamese and CJK UTF-8 multi-language text', () => {
    const vietnamese = 'Xin chào Việt Nam: ắ, ằ, ẳ, ẵ, ặ, ế, ề, ể, ễ, ệ, ố, ồ, ổ, ỗ, ộ, ớ, ờ, ở, ỡ, ợ, ứ, ừ, ử, ữ, ự'
    assert.strictEqual(sanitizeSubtitleText(vietnamese, 'srt'), vietnamese)
    assert.strictEqual(sanitizeSubtitleText(vietnamese, 'ass'), vietnamese)

    const cjk = '大家好，欢迎观看！日本語字幕テスト。'
    assert.strictEqual(sanitizeSubtitleText(cjk, 'srt'), cjk)
    assert.strictEqual(sanitizeSubtitleText(cjk, 'ass'), cjk)
  })

  console.log('\n--- SECTION 4: Reflected XSS Neutralization in API Error Responses ---')

  test('sanitizeErrorMessage escapes executable script tags in error messages', () => {
    const xssMsg = 'User <script>alert(1)</script> not found'
    const safeMsg = sanitizeErrorMessage(xssMsg)
    assert.strictEqual(safeMsg, 'User &lt;script&gt;alert(1)&lt;/script&gt; not found')

    // Preserves legitimate math/range expressions
    const mathMsg = 'Quá nhiều segments một lần (>2000)'
    assert.strictEqual(sanitizeErrorMessage(mathMsg), mathMsg)

    const rangeMsg = 'Timing mask không hợp lệ (0<=start<end)'
    assert.strictEqual(sanitizeErrorMessage(rangeMsg), rangeMsg)
  })

  await asyncTest('sendError helper sanitizes reflected error messages over HTTP', async () => {
    const app = express()
    app.use(express.json())

    app.get('/test-xss-error', (req, res) => {
      sendError(res, 400, 'USER_ERROR', req.query.input)
    })

    const server = app.listen(0)
    await once(server, 'listening')
    const { port } = server.address()
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const res = await fetch(`${baseUrl}/test-xss-error?input=%3Cscript%3Ealert(document.cookie)%3C/script%3E`)
      assert.strictEqual(res.status, 400)
      const body = await res.json()
      assert.strictEqual(body.message, '&lt;script&gt;alert(document.cookie)&lt;/script&gt;')
      assert.strictEqual(body.error.message, '&lt;script&gt;alert(document.cookie)&lt;/script&gt;')
    } finally {
      server.close()
    }
  })

  console.log('\n--- SECTION 5: Subtitle Pipeline Integration ---')

  test('toAss and toSrt integrate sanitization cleanly', () => {
    const cues = [
      { start: 0, end: 5, text: '{\\pos(100,100)}<script>alert(1)</script>Hello world' },
    ]

    const assOutput = toAss(cues, { width: 1920, height: 1080 })
    assert.ok(assOutput.includes('\\{\\\\pos(100,100)\\}'), 'ASS output escapes override tags')

    const srtOutput = toSrt(cues)
    assert.ok(!srtOutput.includes('<script>'), 'SRT output strips script tags')
    assert.ok(srtOutput.includes('Hello world'), 'SRT output preserves text')
  })

  if (failures > 0) {
    console.error(`\nTASK 15 TESTS FAILED: ${failures} failure(s)`)
    process.exit(1)
  } else {
    console.log('\nALL TASK 15 TESTS PASS')
    process.exit(0)
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err)
  process.exit(1)
})
