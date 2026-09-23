// Mask lifecycle invariant: status là SoT duy nhất (decision 3a).
// APPROVED→1, DISABLED→0, DRAFT không render. Không tồn tại APPROVED+0/DISABLED+1.
// Chạy: node tests/maskInvariant.test.mjs
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_maskInvariant_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const { initSchema } = await import('../src/db/schema.js')
const { run } = await import('../src/db/query.js')
const { validateMaskInput, normalizeMaskState } = await import('../src/routes/v1/masks.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const base = { ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3 }

// 1. POST normalize: APPROVED+0 tường minh → APPROVED+1
{
  const r = validateMaskInput({ ...base, status: 'APPROVED', enabled: 0 })
  assert(r.ok && r.value.status === 'APPROVED' && r.value.enabled === 1, `APPROVED+0 → APPROVED+1 (got ${r.value?.status}+${r.value?.enabled})`)
}
// 2. POST normalize: DISABLED+1 → DISABLED+0
{
  const r = validateMaskInput({ ...base, status: 'DISABLED', enabled: 1 })
  assert(r.ok && r.value.status === 'DISABLED' && r.value.enabled === 0, `DISABLED+1 → DISABLED+0 (got ${r.value?.status}+${r.value?.enabled})`)
}
// 3. enabled-only trên APPROVED → DISABLED khi tắt
{
  const n = normalizeMaskState({ enabled: 0 }, { status: 'APPROVED', enabled: 1 })
  assert(n.status === 'DISABLED' && n.enabled === 0, `APPROVED + enabled:0 → DISABLED+0 (got ${n.status}+${n.enabled})`)
}
// 4. enabled-only trên DISABLED → APPROVED khi bật
{
  const n = normalizeMaskState({ enabled: 1 }, { status: 'DISABLED', enabled: 0 })
  assert(n.status === 'APPROVED' && n.enabled === 1, `DISABLED + enabled:1 → APPROVED+1 (got ${n.status}+${n.enabled})`)
}
// 5. status-only APPROVED → enabled 1
{
  const n = normalizeMaskState({ status: 'APPROVED' }, { status: 'DRAFT', enabled: 1 })
  assert(n.status === 'APPROVED' && n.enabled === 1, 'status APPROVED → enabled 1')
}
// 6. Render filter: DRAFT không render, APPROVED render, DISABLED không render
{
  const { loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
  const pid = 'proj-mask-inv'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u1', 'TRANSLATE_DUB', 't'])
  await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-draft', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'DRAFT', 1])
  await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-appr', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'APPROVED', 1])
  await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-dis', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'DISABLED', 0])
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' })
  assert(regions.some((r) => r.id === 'm-appr'), 'APPROVED render')
  assert(!regions.some((r) => r.id === 'm-draft'), 'DRAFT không render')
  assert(!regions.some((r) => r.id === 'm-dis'), 'DISABLED không render')
  await run(`DELETE FROM ocr_regions WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}
// 7. Không còn PATCH mirror cũ mâu thuẫn (chỉ normalize duy nhất)
{
  const fs = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const __d = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(__d, '..', 'src', 'routes', 'v1', 'masks.js'), 'utf8')
  assert(src.includes('normalizeMaskState'), 'masks.js dùng normalizeMaskState duy nhất')
  assert(!src.includes("patch.enabled = v.value.status === 'APPROVED' ? 1"), 'không còn mirror cũ rời rạc')
}

try { const fs = await import('node:fs'); fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
