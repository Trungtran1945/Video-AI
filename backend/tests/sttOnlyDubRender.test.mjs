// STT-only TRANSLATE_DUB render pipeline tests (§4.1)
// Proves current runtime does NOT automatically derive or burn OCR masks from transcript_segments
import path from 'node:path'
import os from 'node:os'

process.env.DB_PATH = path.join(os.tmpdir(), `vidai_stt_only_render_${Date.now()}.db`)

const { initSchema } = await import('../src/db/schema.js')
const { insert, run } = await import('../src/db/query.js')
const { loadSubtitleRegions, deriveAutoRegions } = await import('../src/pipeline/stages/dubRender.js')

await initSchema()

let failures = 0
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg)
  else { failures++; console.error('FAIL:', msg) }
}

const pid = `p-stt-only-${Date.now()}`
await insert('projects', { id: pid, user_id: 'u-stt', mode: 'TRANSLATE_DUB', title: 'stt only' })

// 1. Project has modern ASR segments from dub.stt
await insert('transcript_segments', {
  id: 'seg-asr-1',
  project_id: pid,
  index_num: 0,
  start_sec: 0,
  end_sec: 2.5,
  text: 'ASR transcribed subtitle',
  translation: 'Phụ đề dịch từ ASR',
  source: 'asr',
})

// 2. Project has legacy OCR segments in DB
await insert('transcript_segments', {
  id: 'seg-ocr-legacy',
  project_id: pid,
  index_num: 1,
  start_sec: 3.0,
  end_sec: 5.0,
  text: 'Hardsub on video',
  translation: 'Chữ trên video',
  source: 'ocr',
  ratio_x: 0.1,
  ratio_y: 0.8,
  ratio_w: 0.8,
  ratio_h: 0.15,
})

// 3. Project has a DRAFT mask in ocr_regions
await insert('ocr_regions', {
  id: 'm-draft',
  project_id: pid,
  start_sec: 0,
  end_sec: 2,
  ratio_x: 0.1,
  ratio_y: 0.7,
  ratio_w: 0.8,
  ratio_h: 0.2,
  type: 'blur',
  source: 'MANUAL',
  status: 'DRAFT',
  enabled: 1,
})

// 4. Project has a DISABLED mask in ocr_regions
await insert('ocr_regions', {
  id: 'm-disabled',
  project_id: pid,
  start_sec: 2,
  end_sec: 4,
  ratio_x: 0.1,
  ratio_y: 0.7,
  ratio_w: 0.8,
  ratio_h: 0.2,
  type: 'blur',
  source: 'MANUAL',
  status: 'DISABLED',
  enabled: 0,
})

// 5. Project has an APPROVED mask in ocr_regions
await insert('ocr_regions', {
  id: 'm-approved',
  project_id: pid,
  start_sec: 4,
  end_sec: 6,
  ratio_x: 0.1,
  ratio_y: 0.7,
  ratio_w: 0.8,
  ratio_h: 0.2,
  type: 'blur',
  source: 'MANUAL',
  status: 'APPROVED',
  enabled: 1,
})

// Verification A: loadSubtitleRegions in current STT-only runtime
{
  const activeMasks = await loadSubtitleRegions(pid)
  // MUST NOT include legacy OCR from transcript_segments
  assert(!activeMasks.some((m) => m.id === 'legacy_ocr:seg-ocr-legacy'), 'legacy OCR transcript segments NOT automatically loaded')
  assert(!activeMasks.some((m) => String(m.id).startsWith('legacy_ocr:')), 'no legacy OCR derived masks in render pipeline')
  // MUST NOT include DRAFT mask
  assert(!activeMasks.some((m) => m.id === 'm-draft'), 'DRAFT mask NOT loaded into render')
  // MUST NOT include DISABLED mask
  assert(!activeMasks.some((m) => m.id === 'm-disabled'), 'DISABLED mask NOT loaded into render')
  // MUST include APPROVED mask
  assert(activeMasks.length === 1 && activeMasks[0].id === 'm-approved', 'ONLY APPROVED mask loaded into render (got exactly m-approved)')
  assert(activeMasks[0].status === 'APPROVED', 'loaded mask has status APPROVED')
}

// Verification B: Explicit legacy compatibility flag
{
  const withLegacy = await loadSubtitleRegions(pid, { includeLegacyAuto: true })
  // Even with legacy auto, derived legacy regions have status DRAFT so they are filtered unless approved
  assert(!withLegacy.some((m) => m.id === 'm-draft'), 'DRAFT still excluded with includeLegacyAuto')
  assert(withLegacy.some((m) => m.id === 'm-approved'), 'APPROVED still included')
}

// Verification C: deriveAutoRegions isolated to legacy OCR
{
  const derived = await deriveAutoRegions(pid)
  assert(derived.length === 1, 'deriveAutoRegions only derives explicit source=ocr row')
  assert(derived[0].source === 'LEGACY_OCR', 'derived region marked as LEGACY_OCR')
  assert(derived[0].status === 'DRAFT', 'derived region marked as DRAFT')
}

try { (await import('node:fs')).rmSync(process.env.DB_PATH, { force: true }) } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
if (failures > 0) process.exit(1)
