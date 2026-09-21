// Schema cho subtitle-mask pipeline: transcript_segments có source/confidence/
// + bbox ratio; ocr_regions có type/blur_radius/opacity/enabled.
// Chạy: node tests/maskStore.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_maskstore_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { query } = await import('../src/db/query.js')
const { validateMaskInput } = await import('../src/routes/v1/masks.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

async function cols(table) {
  const rows = await query(`SELECT name FROM pragma_table_info(?) ORDER BY cid`, [table]).catch(() => [])
  if (rows.length) return rows.map((r) => r.name)
  // sql.js pragma via table-valued function may vary — fallback direct form
  const rows2 = await query(`PRAGMA table_info(${table})`)
  return rows2.map((r) => r.name)
}

// 1. transcript_segments: source + confidence + bbox ratio
{
  const c = await cols('transcript_segments')
  for (const col of ['source', 'confidence', 'ratio_x', 'ratio_y', 'ratio_w', 'ratio_h']) {
    assert(c.includes(col), `transcript_segments có cột ${col} (got: ${c.join(',')})`)
  }
}

// 2. ocr_regions: type + blur_radius + opacity + enabled
{
  const c = await cols('ocr_regions')
  for (const col of ['type', 'blur_radius', 'opacity', 'enabled']) {
    assert(c.includes(col), `ocr_regions có cột ${col} (got: ${c.join(',')})`)
  }
}

// 3. validateMaskInput: hợp lệ
{
  const r = validateMaskInput({
    ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2,
    startSec: 1, endSec: 3, type: 'blur', blurRadius: 8, opacity: 1, enabled: true,
  })
  assert(r.ok === true && r.value.type === 'blur', 'mask hợp lệ pass')
  assert(r.value.enabled === 1, 'enabled true -> 1')
}

// 4. validateMaskInput: toạ độ sai
{
  const badX = validateMaskInput({ ratioX: 1.5, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3 })
  assert(badX.ok === false && badX.field === 'ratioX', 'ratioX>1 bị từ chối')
  const badW = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0, ratioH: 0.2, startSec: 1, endSec: 3 })
  assert(badW.ok === false && badW.field === 'ratioW', 'ratioW<=0 bị từ chối')
}

// 5. validateMaskInput: timing sai
{
  const badT = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 3, endSec: 3 })
  assert(badT.ok === false && badT.field === 'endSec', 'end<=start bị từ chối')
  const negT = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: -1, endSec: 3 })
  assert(negT.ok === false && negT.field === 'startSec', 'start<0 bị từ chối')
}

// 6. validateMaskInput: type/blur/opacity sai
{
  const badType = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3, type: 'laser' })
  assert(badType.ok === false && badType.field === 'type', 'type lạ bị từ chối')
  const badBlur = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3, blurRadius: -5 })
  assert(badBlur.ok === false && badBlur.field === 'blurRadius', 'blurRadius âm bị từ chối')
  const badOp = validateMaskInput({ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3, opacity: 2 })
  assert(badOp.ok === false && badOp.field === 'opacity', 'opacity>1 bị từ chối')
}

// 7. validateMaskInput: partial (PATCH) chỉ check field được gửi
{
  const r = validateMaskInput({ opacity: 0.5 }, { partial: true })
  assert(r.ok === true && r.value.opacity === 0.5, 'partial chỉ validate field gửi')
  const bad = validateMaskInput({ opacity: 9 }, { partial: true })
  assert(bad.ok === false && bad.field === 'opacity', 'partial vẫn bắt field sai')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
