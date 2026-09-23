// TRANSLATE_DUB workflow fix (§1-§11): output gating, mask APPROVED lifecycle,
// manual-edit source of truth, realtime vocabulary, OCR consensus, timing clamp.
// Chạy: node tests/translateDubWorkflow.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_workflow_${Date.now()}.db`)
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcFile = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

async function cols(table) {
  const rows = await query(`PRAGMA table_info(${table})`)
  return rows.map((r) => r.name)
}

// ── 1. Schema: mask status + manual-edit flags ──
{
  const oc = await cols('ocr_regions')
  assert(oc.includes('status'), `ocr_regions có cột status (got: ${oc.join(',')})`)
  const tc = await cols('transcript_segments')
  for (const c of ['is_text_manually_edited', 'is_translation_manually_edited']) {
    assert(tc.includes(c), `transcript_segments có cột ${c}`)
  }
}

// ── 2. Mask status validation ──
{
  const { validateMaskInput, toMaskJson } = await import('../src/routes/v1/masks.js')
  const base = { ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, startSec: 1, endSec: 3 }
  const ok = validateMaskInput({ ...base, status: 'APPROVED' })
  assert(ok.ok === true && ok.value.status === 'APPROVED', 'status APPROVED được chấp nhận')
  const def = validateMaskInput({ ...base })
  assert(def.ok === true && def.value.status === 'DRAFT', `mask mới default DRAFT (got: ${def.value.status})`)
  const bad = validateMaskInput({ ...base, status: 'BOGUS' })
  assert(bad.ok === false && bad.field === 'status', 'status lạ bị từ chối')
  const partial = validateMaskInput({ status: 'DISABLED' }, { partial: true })
  assert(partial.ok === true && partial.value.status === 'DISABLED', 'PATCH status DISABLED pass')
  const auto = toMaskJson({ id: 'auto:x', source: 'AUTO', enabled: 1 })
  assert(auto.status === 'APPROVED', `mask AUTO ảo coi như APPROVED (got: ${auto.status})`)
  const manual = toMaskJson({ id: 'm1', source: 'MANUAL', enabled: 1 })
  assert(manual.status === 'DRAFT', `manual thiếu status → DRAFT (got: ${manual.status})`)
}

// ── 3. Output gating: GET /:id ẩn output khi pipeline active ──
{
  const src = srcFile('routes', 'v1', 'projects.js')
  assert(src.includes('ACTIVE_OUTPUT_HIDDEN'), 'projects.js có active-status output gate')
  assert(/pending.*queued.*running.*generating/s.test(src), 'gate bao phủ pending/queued/running/generating')
  assert(src.includes('? null : latestOutput') || src.includes('? null :latestOutput'), 'active → output null (không delete)')
  assert(!/DELETE FROM outputs/.test(src.split('router.get(\'/:id\'')[1].split('router.get')[0]), 'GET handler không DELETE outputs')
}

// ── 4. Realtime vocabulary: completed thống nhất ──
{
  const runner = srcFile('pipeline', 'runner.js')
  assert(!runner.includes("status: done >= total ? 'success'"), 'runner không còn emit success cho __project__')
  assert(runner.includes("status: 'completed', percent: 100"), 'runner emit completed khi xong')
  const events = srcFile('routes', 'v1', 'events.js')
  assert(events.includes("'completed'"), 'events.js done-condition bao gồm completed')
}

// ── 5. Render: APPROVED-only + alignEnd clamp + final verify ──
{
  const { normalizeRegion, alignEnd, loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js')
  const draft = normalizeRegion({ ratio_x: 0.1, ratio_y: 0.7, ratio_w: 0.8, ratio_h: 0.2, start_sec: 1, end_sec: 3, source: 'MANUAL' })
  assert(draft?.status === 'DRAFT', `normalize MANUAL thiếu status → DRAFT (got: ${draft?.status})`)
  const appr = normalizeRegion({ ratio_x: 0.1, ratio_y: 0.7, ratio_w: 0.8, ratio_h: 0.2, start_sec: 1, end_sec: 3, source: 'MANUAL', status: 'APPROVED' })
  assert(appr?.status === 'APPROVED', 'normalize giữ APPROVED')

  // DB: DRAFT bị loại, APPROVED được giữ
  const pid = 'proj-wf-render'
  await run(`INSERT INTO projects (id, user_id, mode, title) VALUES (?, ?, ?, ?)`, [pid, 'u-wf', 'TRANSLATE_DUB', 'wf'])
  await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-draft', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'DRAFT', 1])
  await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['m-appr', pid, 0, 2, 0.1, 0.7, 0.8, 0.2, 'MANUAL', 'APPROVED', 1])
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' })
  assert(regions.some((r) => r.id === 'm-appr'), 'loadSubtitleRegions giữ APPROVED')
  assert(!regions.some((r) => r.id === 'm-draft'), 'loadSubtitleRegions loại DRAFT')

  // alignEnd clamp với cue kế
  const regs = [{ ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2, start_sec: 0, end_sec: 5, enabled: 1, status: 'APPROVED' }]
  const clamped = alignEnd({ start_sec: 0, end_sec: 4.5 }, regs, 4.6)
  assert(clamped <= 4.6, `alignEnd clamp với cue kế (got: ${clamped})`)
  const extended = alignEnd({ start_sec: 0, end_sec: 4.5 }, regs, 10)
  assert(extended === 5, `alignEnd vẫn kéo tới region end khi không overlap (got: ${extended})`)

  const renderSrc = srcFile('pipeline', 'stages', 'dubRender.js')
  assert(renderSrc.includes('BLOCK_RENDER: INVALID_FINAL'), 'render verify final duration')
  await run(`DELETE FROM ocr_regions WHERE project_id = ?`, [pid])
  await run(`DELETE FROM projects WHERE id = ?`, [pid])
}

// ── 6. PUT transcript nhận text + flags; dubTranslate skip bản sửa tay ──
{
  const dubData = srcFile('routes', 'v1', 'dubData.js')
  assert(dubData.includes('is_text_manually_edited'), 'PUT set is_text_manually_edited')
  assert(dubData.includes('is_translation_manually_edited'), 'PUT set is_translation_manually_edited')
  assert(dubData.includes('translation=NULL') || dubData.includes('translation = NULL') || dubData.includes('newTranslation = null'), 'text đổi không kèm translation → clear để dịch lại')
  const tr = srcFile('pipeline', 'stages', 'dubTranslate.js')
  assert(tr.includes('is_translation_manually_edited'), 'dubTranslate tôn trọng flag sửa tay')
  assert(tr.includes('isManualTranslation'), 'dubTranslate có guard isManualTranslation')
}

// ── 7. OCR: consensus + language hint + độc lập mask ──
{
  const ocr = srcFile('pipeline', 'stages', 'dubOcr.js')
  assert(ocr.includes('OCR_MIN_FRAMES'), 'OCR_MIN_FRAMES env-tunable')
  assert(ocr.includes('OCR_SINGLE_FRAME_CONF'), 'single-frame conf guard cho subtitle ngắn')
  assert(!ocr.includes('applySubtitleMasks') && !ocr.includes('buildMaskFilter'), 'OCR không áp mask trước khi đọc (§6)')
  const gemini = srcFile('providers', 'vision', 'geminiVision.js')
  assert(gemini.includes('sourceLanguage'), 'Gemini detectSubtitle nhận sourceLanguage hint')
}

// ── 8. RESETS không đụng ocr_regions (mask giữ nguyên suốt pipeline §4) ──
{
  const runner = srcFile('pipeline', 'runner.js')
  assert(!runner.includes('ocr_regions'), 'runner RESETS không xoá ocr_regions')
}

try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
