// Render masking: vùng hardsub gốc bị blur/cover TRƯỚC khi burn subtitle dịch.
// - buildMaskFilter dựng filter graph từ ratio regions (không hard-code res).
// - applySubtitleMasks no-op khi không có mask (không re-encode).
// - render order: mask → ASS → audio → mux (sub dịch luôn visible).
// Chạy: node tests/maskRender.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMaskFilter, applySubtitleMasks } from '../src/media/mediaService.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const blur1 = {
  id: 'm1', ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2,
  start_sec: 1, end_sec: 3, type: 'blur', blur_radius: 8, opacity: 1, enabled: 1, source: 'AUTO',
}

// 1. Blur region → crop + boxblur + overlay theo timeline
{
  const f = buildMaskFilter([blur1], { width: 1280, height: 720 })
  assert(f && f.isComplex === true, 'blur dùng filter_complex')
  assert(/crop=1024:144:128:504/.test(f.filter), `crop đúng pixel từ ratio (got: ${f.filter.slice(0, 120)})`)
  assert(/boxblur=8:1/.test(f.filter), 'boxblur đúng radius')
  assert(/overlay=128:504:enable='between\(t,1,3\)'/.test(f.filter), 'overlay đúng vị trí + timeline')
}

// 2. Solid region → drawbox cover, sub dịch sau đó vẫn visible (không blur cả khung)
{
  const f = buildMaskFilter([{ ...blur1, id: 'm2', type: 'solid', opacity: 0.9 }], { width: 1280, height: 720 })
  assert(/drawbox=.*t=fill:enable='between\(t,1,3\)'/.test(f.filter), 'solid dùng drawbox fill theo timeline')
  assert(!/boxblur/.test(f.filter), 'solid không blur')
}

// 3. Nhiều masks nối chuỗi labels, overlap không vỡ graph
{
  const f = buildMaskFilter([
    blur1,
    { ...blur1, id: 'm3', start_sec: 2, end_sec: 4, ratioY: 0.1 },
  ], { width: 1280, height: 720 })
  assert(/\[v1\].*\[v2\]/.test(f.filter), 'nhiều mask nối chuỗi labels')
  assert((f.filter.match(/between\(t,/g) || []).length === 2, 'mỗi mask có timeline riêng')
}

// 4. Mask disabled bị bỏ qua
{
  const f = buildMaskFilter([{ ...blur1, enabled: 0 }], { width: 1280, height: 720 })
  assert(f === null, 'disabled → null (không re-encode)')
  assert(await applySubtitleMasks('/tmp/in.mp4', [{ ...blur1, enabled: 0 }], { width: 1280, height: 720, out: '/tmp/out.mp4' }) === '/tmp/in.mp4', 'apply no-op trả về file gốc')
}

// 5. Rỗng → null
{
  assert(buildMaskFilter([], { width: 1280, height: 720 }) === null, 'rỗng → null')
}

// 6. Region enabled nhưng invalid → BLOCK_RENDER rõ ràng (không silent skip)
{
  let msg = ''
  try {
    buildMaskFilter([{ ...blur1, ratioW: 0 }], { width: 1280, height: 720 })
  } catch (e) { msg = e.message }
  assert(msg.startsWith('BLOCK_RENDER:'), `invalid mask BLOCK_RENDER (got: ${msg.slice(0, 60)})`)
}

// 7. Resolution-independent: cùng ratio, res khác → pixel khác
{
  const a = buildMaskFilter([blur1], { width: 1280, height: 720 })
  const b = buildMaskFilter([blur1], { width: 1920, height: 1080 })
  assert(a.filter !== b.filter && /crop=1536:216:192:756/.test(b.filter), 'pixel scale theo resolution thật')
}

// 8. Render order trong dubRender: mask TRƯỚC burn ASS
{
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'stages', 'dubRender.js'), 'utf8')
  const iMask = src.indexOf('applySubtitleMasks')
  const iBurn = src.indexOf('burnSubtitlesStyled(workingFile')
  assert(iMask > 0 && iBurn > 0 && iMask < iBurn, 'applySubtitleMasks chạy trước burn ASS (sub dịch không bị che)')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
