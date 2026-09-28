// Mask APPROVED → dub.render plumbing: DRAFT/DISABLED bị loại, APPROVED đi qua
// loadSubtitleRegions tới buildMaskFilter với đúng toạ độ/timing; invalid thì
// BLOCK_RENDER rõ ràng (không silent skip).
// Chạy: node tests/maskApproveToRender.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_maskApprove_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const { loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
const { buildMaskFilter } = await import('../src/media/mediaService.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const pid = 'proj-mask-approve-render'
await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
// MANUAL blur mask: DRAFT (chưa approve) vs APPROVED vs DISABLED — cùng toạ độ/timing.
const rows = [
  ['m-draft', 'DRAFT', 1],
  ['m-appr', 'APPROVED', 1],
  ['m-dis', 'DISABLED', 0],
]
for (const [id, status, enabled] of rows) {
  await run(
    `INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, type, blur_radius, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, pid, 1, 3, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'blur', 8, status, enabled]
  )
}

// 1. Chỉ APPROVED MANUAL được chọn render.
{
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' })
  const ids = regions.map((r) => r.id)
  assert(ids.includes('m-appr'), 'APPROVED manual mask được chọn render')
  assert(!ids.includes('m-draft'), 'DRAFT không render (TEST 6)')
  assert(!ids.includes('m-dis'), 'DISABLED không render (TEST 9)')
}

// 2. APPROVED mask tới buildMaskFilter với đúng toạ độ/timing (1280x720).
{
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' })
  const approved = regions.filter((r) => r.id === 'm-appr')
  const f = buildMaskFilter(approved, { width: 1280, height: 720 })
  assert(f && f.isComplex === true, 'APPROVED blur dùng filter_complex (TEST 8)')
  assert(/crop=1024:144:128:504/.test(f.filter), 'toạ độ pixel đúng từ ratio (TEST 10)')
  assert(/boxblur=8:1/.test(f.filter), 'blurRadius được tôn trọng (TEST 10)')
  assert(/between\(t,1,3\)/.test(f.filter), 'timing start/end được tôn trọng (TEST 10)')
}

// 3. Chỉ còn DRAFT → không có gì để render (null, không re-encode).
{
  await run(`DELETE FROM ocr_regions WHERE project_id = ?`, [pid])
  await run(
    `INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, type, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-only-draft', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'blur', 'DRAFT', 1]
  )
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' })
  assert(!regions.some((r) => r.id === 'm-only-draft'), 'DRAFT đơn lẻ không render')
  assert(buildMaskFilter([], { width: 1280, height: 720 }) === null, 'không mask → null (giữ nguyên file)')
}

// 4. Mask invalid không bị bỏ qua lặng — BLOCK_RENDER diagnosable.
{
  let msg = ''
  try {
    buildMaskFilter([{ id: 'm-bad', ratioX: 0.1, ratioY: 0.7, ratioW: 0, ratioH: 0.2, start_sec: 1, end_sec: 3, type: 'blur', enabled: 1 }], { width: 1280, height: 720 })
  } catch (e) { msg = e.message }
  assert(msg.startsWith('BLOCK_RENDER:'), 'invalid mask BLOCK_RENDER rõ ràng')
}

await run(`DELETE FROM ocr_regions WHERE project_id = ?`, [pid])
await run(`DELETE FROM projects WHERE id = ?`, [pid])

try { const fs = await import('node:fs'); fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
