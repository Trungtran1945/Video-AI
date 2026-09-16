// TTS strict + render gates: partial->FAILED, missing/dup/overlap blocked, ID mapping.
// Run: node backend/tests/ttsRenderGate.test.mjs
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-ttsgate-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmpeg\\bin\\ffmpeg.exe'
process.env.FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmpeg\\bin\\ffprobe.exe'
process.env.GEMINI_API_KEY = 'test-key'

const { initSchema } = await import('../src/db/schema.js')
const { query, run } = await import('../src/db/query.js')
const { validateForRender } = await import('../src/pipeline/stages/dubMerge.js')
const { resolveAudioEntries } = await import('../src/pipeline/stages/dubRender.js')
const { validateNoOverlap } = await import('../src/pipeline/forcedAlignService.js')
const { default: dubTtsAlign } = await import('../src/pipeline/stages/dubTtsAlign.js')
const { default: MockTts } = await import('../src/providers/tts/mockTts.js')

await initSchema()

let failures = 0
const assert = (c, m) => { if (c) console.log('PASS:', m); else { failures++; console.error('FAIL:', m) } }

let n = 0
async function makeProject({ segs, enableDubbing = true }) {
  n++
  const userId = `ut${n}`, projectId = `pt${n}`
  await run('INSERT OR IGNORE INTO settings (user_id, active_llm_provider, active_translate_provider, active_voice_provider) VALUES (?, ?, ?, ?)',
    [userId, 'gemini', 'google_translate', 'mock'])
  await run('INSERT INTO projects (id, user_id, mode, title, params) VALUES (?, ?, ?, ?, ?)',
    [projectId, userId, 'TRANSLATE_DUB', `T${n}`, JSON.stringify({ targetLanguage: 'vi', sourceLanguage: 'en', enableDubbing })])
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    await run('INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation, tts_audio_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [s.id, projectId, i, s.start, s.end, s.text, s.translation || null, s.tts_audio_id || null])
    if (s.audio) {
      await run('INSERT INTO audios (id, project_id, kind, duration_sec, provider) VALUES (?, ?, ?, ?, ?)',
        [s.audio.id, projectId, 'voice', s.audio.dur, 'mock'])
    }
  }
  const project = (await query('SELECT * FROM projects WHERE id = ?', [projectId]))[0]
  return { project, ctx: { project, job: { id: `jobt${n}` }, setProgress: () => {}, signal: undefined } }
}

// 7. TTS partial failure -> stage FAILED strict (not COMPLETED), bounded retry
{
  const orig = MockTts.prototype.synthesize
  let calls = 0
  MockTts.prototype.synthesize = async () => {
    calls++
    const e = new Error('timeout fetching tts')
    throw e // TRANSIENT per classifier (contains timeout)
  }
  const { project, ctx } = await makeProject({
    segs: [
      { id: 'tts_a', start: 0, end: 2, text: 'hello', translation: 'xin chào' },
      { id: 'tts_b', start: 2.5, end: 4.5, text: 'world', translation: 'thế giới' },
    ],
  })
  let threw = null
  try {
    await dubTtsAlign(ctx)
  } catch (e) {
    threw = e
  }
  MockTts.prototype.synthesize = orig
  assert(threw && /incomplete: 0\/2/.test(threw.message), `TTS all-fail -> FAILED strict (got: ${threw?.message?.slice(0, 120) || 'no throw'})`)
  // 2 segments x (1 + 1 retry) = 4 calls bounded, not infinite
  assert(calls === 4, `TTS transient bounded retry 1x per segment (calls=${calls})`)
  await run('DELETE FROM provider_cache')
}

// 8. Missing translation with dubbing=false -> partial render (Policy A:
// SUBTITLE_SKIPPED warning, valid=true). BLOCK only when dubbing=true.
{
  const { project } = await makeProject({
    enableDubbing: false,
    segs: [{ id: 'r1', start: 0, end: 1.5, text: 'hello', translation: null }],
  })
  const v = await validateForRender(project.id)
  assert(v.valid === true && v.errors.length === 0 && v.warnings.some((e) => e.code === 'SUBTITLE_SKIPPED'), 'subtitle-only missing translation -> partial valid + SUBTITLE_SKIPPED')
}

// 9. Render blocked when TTS missing and dubbing on
{
  const { project } = await makeProject({
    enableDubbing: true,
    segs: [{ id: 'r2', start: 0, end: 1.5, text: 'hello', translation: 'xin chào', tts_audio_id: null }],
  })
  const v = await validateForRender(project.id)
  assert(v.valid === false && v.errors.some((e) => e.code === 'MISSING_TTS_AUDIO'), 'render blocked: missing TTS when dubbing')
}

// 10. Segment/audio mapping by ID (never index)
{
  const rows = [
    { id: 'segA', start_sec: 0, end_sec: 2, audio_id: 'audA' },
    { id: 'segB', start_sec: 2.5, end_sec: 4.5, audio_id: 'audB' },
  ]
  const aligns = [
    { segmentId: 'segA', audioId: 'audA', startAtSec: 0, endAtSec: 1.8 },
    { segmentId: 'segB', audioId: 'audB', startAtSec: 2.5, endAtSec: 4.3 },
  ]
  const tmpF1 = path.join(tmpRoot, 'a.wav')
  const tmpF2 = path.join(tmpRoot, 'b.wav')
  fs.writeFileSync(tmpF1, 'x')
  fs.writeFileSync(tmpF2, 'y')
  const files = new Map([['audA', tmpF1], ['seg:segB', tmpF2]])
  const out = resolveAudioEntries(rows, aligns, files)
  assert(out.get('segA')?.file === tmpF1, 'ID mapping: segA->audA file')
  assert(out.get('segB')?.file === tmpF2, 'ID mapping: segB via seg: key')
  // Missing audio -> no entry (caller BLOCK_RENDERs, never borrows)
  const out2 = resolveAudioEntries([{ id: 'segC', start_sec: 5, end_sec: 6, audio_id: null }], [], files)
  assert(!out2.get('segC'), 'missing audio -> no entry (no borrowing)')
}

// 11. Duplicate audio blocked
{
  const { project } = await makeProject({
    segs: [
      { id: 'd1', start: 0, end: 2, text: 'a', translation: 'một', tts_audio_id: 'shared', audio: { id: 'shared', dur: 1.5 } },
      { id: 'd2', start: 2.5, end: 4.5, text: 'b', translation: 'hai', tts_audio_id: 'shared' },
    ],
  })
  const v = await validateForRender(project.id)
  assert(v.valid === false && v.errors.some((e) => e.code === 'DUPLICATE_AUDIO'), 'duplicate audio blocked 1:1')
  // Resolver also blocks duplicate file assignment
  const f = path.join(tmpRoot, 'dup.wav')
  fs.writeFileSync(f, 'z')
  const out = resolveAudioEntries(
    [{ id: 'd1', start_sec: 0, end_sec: 2, audio_id: 'shared' }, { id: 'd2', start_sec: 2.5, end_sec: 4.5, audio_id: 'shared' }],
    [{ segmentId: 'd1', audioId: 'shared', startAtSec: 0, endAtSec: 1 }, { segmentId: 'd2', audioId: 'shared', startAtSec: 2.5, endAtSec: 3 }],
    new Map([['shared', f]])
  )
  assert(out.size === 1, `resolver blocks duplicate file (size=${out.size})`)
}

// 12. Audio/timeline overlap blocked
{
  const nov = validateNoOverlap([
    { segmentId: 'a', startAtSec: 0, endAtSec: 2 },
    { segmentId: 'b', startAtSec: 1.9, endAtSec: 3 },
  ])
  assert(!nov.ok, 'physical overlap blocked')
  const { project } = await makeProject({
    segs: [
      { id: 'o1', start: 0, end: 2, text: 'a', translation: 'một', tts_audio_id: 'ao1', audio: { id: 'ao1', dur: 1.5 } },
      { id: 'o2', start: 1.5, end: 3, text: 'b', translation: 'hai', tts_audio_id: 'ao2', audio: { id: 'ao2', dur: 1 } },
    ],
  })
  const v = await validateForRender(project.id)
  assert(v.valid === false && v.errors.some((e) => e.code === 'OVERLAP' || e.code === 'TIMELINE_OVERLAP'), 'timeline overlap blocked')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
