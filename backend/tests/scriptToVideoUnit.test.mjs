import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  SCRIPT_LIMITS,
  ScriptValidationError,
  sha256Hex,
  normalizeScriptText,
  decodeScriptBuffer,
  prepareScriptText,
  normalizeCoverage,
  chunkScript,
  deterministicSegments,
  validateSegments,
  parseLlmSegments,
  segmentContentHash,
} from '../src/services/scriptService.js'
import { bmpBuffer, writeBmp, isBmpFile } from '../src/lib/bmp.js'
import { SlideImage } from '../src/providers/image/slideImage.js'

console.log('=== SCRIPT_TO_VIDEO Unit Tests ===\n')

// 1. Text normalization & decoding
{
  console.log('--- 1. normalizeScriptText & decodeScriptBuffer ---')
  const withBom = '\uFEFFHello\r\nWorld\r\n'
  assert.equal(normalizeScriptText(withBom), 'Hello\nWorld', 'Strips BOM and converts CRLF to LF')

  const buf = Buffer.from('Xin chào Việt Nam', 'utf8')
  assert.equal(decodeScriptBuffer(buf), 'Xin chào Việt Nam', 'Decodes valid UTF-8')

  assert.throws(
    () => decodeScriptBuffer(Buffer.from([])),
    (err) => err instanceof ScriptValidationError && err.code === 'SCRIPT_EMPTY',
    'Rejects empty buffer'
  )

  const badUtf8 = Buffer.from([0xff, 0xfe, 0x12])
  assert.throws(
    () => decodeScriptBuffer(badUtf8),
    (err) => err instanceof ScriptValidationError && err.code === 'SCRIPT_ENCODING_INVALID',
    'Rejects invalid UTF-8'
  )

  const nulBuf = Buffer.from('Test\u0000String', 'utf8')
  assert.throws(
    () => decodeScriptBuffer(nulBuf),
    (err) => err instanceof ScriptValidationError && err.code === 'SCRIPT_ENCODING_INVALID',
    'Rejects NUL character'
  )
  console.log('PASS: text decoding and sanitization')
}

// 2. prepareScriptText & Limits
{
  console.log('--- 2. prepareScriptText limits ---')
  const text = 'Đoạn văn bản kiểm thử độ dài.'
  const prep = prepareScriptText(Buffer.from(text, 'utf8'))
  assert.equal(prep.text, text)
  assert.equal(prep.charCount, [...text].length)
  assert.equal(prep.sha256, sha256Hex(text))

  const oversized = 'a'.repeat(SCRIPT_LIMITS.maxChars + 1)
  assert.throws(
    () => prepareScriptText(Buffer.from(oversized, 'utf8')),
    (err) => err instanceof ScriptValidationError && err.code === 'SCRIPT_TOO_LARGE',
    'Rejects oversized scripts exceeding 60,000 chars'
  )
  console.log('PASS: prepareScriptText and char limit')
}

// 3. normalizeCoverage & chunkScript
{
  console.log('--- 3. normalizeCoverage & chunkScript ---')
  const a = 'Chào  bạn\n\nhôm nay  thế nào?'
  const b = 'chào bạn hôm nay thế nào?'
  assert.equal(normalizeCoverage(a), normalizeCoverage(b), 'Collapses whitespace and normalizes case')

  const script = 'Câu một. Câu hai. Câu ba. Câu bốn. Câu năm.'
  const chunks = chunkScript(script, 25)
  assert(chunks.length >= 2, 'Chunks text properly')
  const reassembled = chunks.join(' ')
  assert.equal(normalizeCoverage(reassembled), normalizeCoverage(script), 'Chunking preserves 100% of text')
  console.log('PASS: coverage normalization and chunking')
}

// 4. deterministicSegments
{
  console.log('--- 4. deterministicSegments ---')
  const sample = [
    'Trí tuệ nhân tạo đang thay đổi thế giới. Mỗi ngày có nhiều phát minh mới được ra đời.',
    'Các mô hình ngôn ngữ lớn ngày càng trở nên mạnh mẽ và hữu ích trong đời sống.',
    'Chúng ta có thể tự động hoá việc tạo video từ kịch bản một cách dễ dàng.',
  ].join('\n\n')

  const segs = deterministicSegments(sample, { maxSegmentChars: 100 })
  assert(segs.length >= 3, 'Generates multiple segments')
  for (const s of segs) {
    assert(s.narrationText.length <= 100, 'Each segment respects length cap')
    assert(s.visualPrompt.length > 0, 'Visual prompt generated from text')
  }
  const concat = segs.map((s) => s.narrationText).join(' ')
  assert.equal(normalizeCoverage(concat), normalizeCoverage(sample), 'Deterministic segmentation covers 100% verbatim text')
  console.log('PASS: deterministic verbatim segmentation')
}

// 5. validateSegments & parseLlmSegments
{
  console.log('--- 5. validateSegments & parseLlmSegments ---')
  const source = 'Câu thứ nhất. Câu thứ hai.'
  const validSegs = [
    { narrationText: 'Câu thứ nhất.', visualPrompt: 'Hình một' },
    { narrationText: 'Câu thứ hai.', visualPrompt: 'Hình hai' },
  ]
  const res1 = validateSegments(validSegs, source)
  assert.equal(res1.ok, true, 'Validates matching segments')

  const missingSegs = [{ narrationText: 'Câu thứ nhất.', visualPrompt: 'Hình một' }]
  const res2 = validateSegments(missingSegs, source)
  assert.equal(res2.ok, false, 'Detects coverage mismatch')

  const jsonFenced = '```json\n{"segments":[{"narrationText":"Đoạn 1","visualPrompt":"Prompt 1"}]}\n```'
  const parsed = parseLlmSegments(jsonFenced)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].narrationText, 'Đoạn 1')
  assert.equal(parsed[0].visualPrompt, 'Prompt 1')

  assert.equal(parseLlmSegments('invalid json text'), null, 'Handles invalid JSON safely')
  console.log('PASS: validation and LLM response parsing')
}

// 6. segmentContentHash
{
  console.log('--- 6. segmentContentHash ---')
  const h1 = segmentContentHash('Nội dung A', 'Hình A')
  const h2 = segmentContentHash('Nội dung A', 'Hình A')
  const h3 = segmentContentHash('Nội dung A', 'Hình B')
  assert.equal(h1, h2, 'Deterministic hash')
  assert.notEqual(h1, h3, 'Different prompt gives different hash')
  console.log('PASS: segmentContentHash')
}

// 7. BMP writer & validator
{
  console.log('--- 7. bmp.js ---')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmp-test-'))
  const bmpPath = path.join(tmpDir, 'test.bmp')
  try {
    writeBmp(bmpPath, {
      pixelAt: (x, y, w, h) => ({ r: 100, g: 150, b: 200 }),
      width: 100,
      height: 50,
    })

    assert(fs.existsSync(bmpPath), 'BMP file written')
    assert(isBmpFile(bmpPath), 'Valid BMP format detected')

    const buf = fs.readFileSync(bmpPath)
    assert.equal(buf.toString('ascii', 0, 2), 'BM', 'Header starts with BM')
    assert.equal(buf.readInt32LE(18), 100, 'Width matches')
    assert.equal(buf.readInt32LE(22), 50, 'Height matches')
    assert.equal(buf.readUInt16LE(28), 24, '24 bits per pixel')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  console.log('PASS: bmpBuffer and writeBmp')
}

// 8. SlideImage provider
{
  console.log('--- 8. SlideImage provider ---')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-test-'))
  const imgPath = path.join(tmpDir, 'slide.bmp')
  const prevPath = path.join(tmpDir, 'preview.bmp')
  try {
    const provider = new SlideImage()
    const out = await provider.generate({
      prompt: 'Trí tuệ nhân tạo tương lai',
      text: 'Trí tuệ nhân tạo đang phát triển.',
      width: 960,
      height: 540,
      outPath: imgPath,
      previewPath: prevPath,
      seed: 'seed123',
    })

    assert.equal(out.imagePath, imgPath)
    assert.equal(out.previewPath, prevPath)
    assert.equal(out.mime, 'image/bmp')
    assert(isBmpFile(imgPath), 'Generated slide is valid BMP')
    assert(isBmpFile(prevPath), 'Generated preview is valid BMP')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  console.log('PASS: SlideImage provider generation')
}

console.log('\nALL SCRIPT_TO_VIDEO UNIT TESTS PASS')
