import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-dubbing-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default

await initSchema()

const user = { id: 'dubbing-test-user', email: 'dubbing@test.local', role: 'user', password: 'test' }
await insert('users', user)
const token = generateAccessToken(user)

let failures = 0
function assert(condition, message) {
  if (condition) console.log('PASS:', message)
  else { failures += 1; console.error('FAIL:', message) }
}

async function makeProject(id, params) {
  await insert('projects', {
    id,
    user_id: user.id,
    mode: 'TRANSLATE_DUB',
    title: 'Dubbing Test',
    status: 'completed',
    language: 'vi',
    target_duration_sec: 60,
    params: JSON.stringify(params),
    transcript_version: 2,
  })
  await insert('transcript_segments', {
    id: `${id}-seg1`,
    project_id: id,
    index_num: 0,
    start_sec: 0,
    end_sec: 2,
    text: 'hello',
    translation: 'xin chào',
    tts_audio_id: 'audio-1',
    tts_clip_key: 'clip-1',
  })
}

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)
const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

async function patch(id, body) {
  const res = await fetch(`${baseUrl}/${id}/dubbing`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch (_) {}
  return { status: res.status, body: json }
}

// T-D01: đổi model TTS
const p1 = 'proj-d01'
await makeProject(p1, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r1 = await patch(p1, { enableDubbing: true, voiceProvider: 'elevenlabs' })
assert(r1.status === 200, 'T-D01 status 200')
assert(r1.body?.params?.voiceProvider === 'elevenlabs', 'T-D01 voiceProvider updated')
const seg1 = await queryOne('SELECT tts_audio_id, tts_clip_key FROM transcript_segments WHERE project_id = ?', [p1])
assert(seg1?.tts_audio_id == null && seg1?.tts_clip_key == null, 'T-D01 tts unlinked')
const proj1 = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [p1])
assert(Number(proj1?.transcript_version) === 2, 'T-D09 transcript_version unchanged')

// T-D02: tắt lồng tiếng
const p2 = 'proj-d02'
await makeProject(p2, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r2 = await patch(p2, { enableDubbing: false })
assert(r2.status === 200, 'T-D02 status 200')
assert(r2.body?.params?.enableDubbing === false, 'T-D02 enableDubbing false')
assert(r2.body?.params?.audioMode === 'ORIGINAL_ONLY', 'T-D02 audioMode ORIGINAL_ONLY')
const seg2 = await queryOne('SELECT tts_audio_id FROM transcript_segments WHERE project_id = ?', [p2])
assert(seg2?.tts_audio_id == null, 'T-D02 tts unlinked')

// T-D03: bật lại
const r3 = await patch(p2, { enableDubbing: true, voiceProvider: 'edge_tts' })
assert(r3.status === 200, 'T-D03 status 200')
assert(r3.body?.params?.enableDubbing === true, 'T-D03 enableDubbing true')
assert(r3.body?.params?.audioMode === 'DUB_MIX', 'T-D03 audioMode default DUB_MIX')

// T-D04: validation provider
const p4 = 'proj-d04'
await makeProject(p4, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r4 = await patch(p4, { enableDubbing: true, voiceProvider: 'not_a_provider' })
assert(r4.status === 400, 'T-D04 status 400')

// T-D05: google_tts + voiceId
const p5 = 'proj-d05'
await makeProject(p5, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r5 = await patch(p5, { enableDubbing: true, voiceProvider: 'google_tts', voiceId: 'abc' })
assert(r5.status === 400, 'T-D05 status 400')
assert(r5.body?.error?.code === 'SCRIPT_VOICE_UNSUPPORTED' || r5.body?.code === 'SCRIPT_VOICE_UNSUPPORTED', 'T-D05 code SCRIPT_VOICE_UNSUPPORTED')

// T-D06: audioMode invalid
const p6 = 'proj-d06'
await makeProject(p6, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r6 = await patch(p6, { enableDubbing: true, audioMode: 'FOO' })
assert(r6.status === 400, 'T-D06 status 400')

// T-D07: non-dub project
const p7 = 'proj-d07'
await insert('projects', {
  id: p7,
  user_id: user.id,
  mode: 'SUMMARY',
  title: 'Summary',
  status: 'completed',
  language: 'vi',
  target_duration_sec: 60,
  params: JSON.stringify({}),
})
const r7 = await patch(p7, { enableDubbing: false })
assert(r7.status === 400, 'T-D07 status 400')

// voiceId format invalid
const p8 = 'proj-d08'
await makeProject(p8, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r8 = await patch(p8, { enableDubbing: true, voiceId: '!!!' })
assert(r8.status === 400, 'voiceId invalid -> 400')

// body rỗng success
const p9 = 'proj-d09'
await makeProject(p9, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r9 = await patch(p9, {})
assert(r9.status === 200, 'empty body -> 200')

// T-D10: Không phải owner -> 403 Forbidden
const otherUser = { id: 'other-user', email: 'other@test.local', role: 'user', password: 'test' }
await insert('users', otherUser)
const otherToken = generateAccessToken(otherUser)
const resOther = await fetch(`${baseUrl}/${p1}/dubbing`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ enableDubbing: true }),
})
assert(resOther.status === 403, 'non-owner receives 403 Forbidden')

// T-D11: Giữ nguyên provider -> không bị unlink tts_audio_id
const p10 = 'proj-d10'
await makeProject(p10, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: 'OriginalVoice', audioMode: 'DUB_MIX' })
const r10 = await patch(p10, { enableDubbing: true, voiceProvider: 'edge_tts', voiceName: 'NewVoiceName' })
assert(r10.status === 200, 'T-D11 same provider update 200')
const seg10 = await queryOne('SELECT tts_audio_id, tts_clip_key FROM transcript_segments WHERE project_id = ?', [p10])
assert(seg10?.tts_audio_id === 'audio-1' && seg10?.tts_clip_key === 'clip-1', 'T-D11 tts preserved when provider unchanged')

// T-D12: AudioMode coercion
const p11 = 'proj-d11'
await makeProject(p11, { enableDubbing: true, voiceProvider: 'edge_tts', voiceId: null, voiceName: null, audioMode: 'DUB_MIX' })
const r12a = await patch(p11, { enableDubbing: true, audioMode: 'ORIGINAL_ONLY' })
assert(r12a.status === 200 && r12a.body?.params?.audioMode === 'DUB_MIX', 'T-D12a ORIGINAL_ONLY coerced to DUB_MIX when enableDubbing: true')
const r12b = await patch(p11, { enableDubbing: false, audioMode: 'DUB_REPLACE' })
assert(r12b.status === 200 && r12b.body?.params?.audioMode === 'ORIGINAL_ONLY', 'T-D12b audioMode coerced to ORIGINAL_ONLY when enableDubbing: false')

// T-D13: Chấp nhận tất cả valid providers
for (const prov of ['voicestudio', 'edge_tts', 'elevenlabs', 'azure_speech', 'openai_tts']) {
  const rp = await patch(p1, { enableDubbing: true, voiceProvider: prov })
  assert(rp.status === 200, `T-D13 provider ${prov} accepted`)
}

await new Promise((resolve) => server.close(resolve))
// cleanup
for (const id of ['proj-d01','proj-d02','proj-d04','proj-d05','proj-d06','proj-d07','proj-d08','proj-d09','proj-d10','proj-d11']) {
  await run('DELETE FROM transcript_segments WHERE project_id = ?', [id])
  await run('DELETE FROM projects WHERE id = ?', [id])
}
await run('DELETE FROM users WHERE id IN (?, ?)', [user.id, otherUser.id])
fs.rmSync(process.env.DB_PATH, { force: true })

if (failures > 0) process.exit(1)
console.log('ALL PASS')
process.exit(0)