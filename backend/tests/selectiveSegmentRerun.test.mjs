import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import express from 'express'
import { once } from 'node:events'

// Isolated DB for testing
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai-selective-rerun-'))
process.env.DB_PATH = path.join(tmpRoot, 'test.db')
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage')

const { initSchema } = await import('../src/db/schema.js')
const { query, queryOne, insert, run } = await import('../src/db/query.js')
const { generateAccessToken } = await import('../src/middleware/auth.js')
const projectsRouter = (await import('../src/routes/v1/projects.js')).default

await initSchema()

const user = { id: 'test-user-selective', email: 'test_selective@asf.local', role: 'user', password: 'test' }
const token = generateAccessToken(user)
const projectId = 'proj-selective-test'

await insert('users', user)
await insert('projects', {
  id: projectId,
  user_id: user.id,
  mode: 'TRANSLATE_DUB',
  title: 'Selective Rerun Project',
  status: 'completed',
  language: 'vi',
  target_duration_sec: 60,
  params: JSON.stringify({ targetLanguage: 'vi', sourceLanguage: 'en', voice: 'maichi' }),
  transcript_version: 1,
})

// Insert sample transcript segments
await insert('transcript_segments', {
  id: 'seg-1',
  project_id: projectId,
  index_num: 0,
  start_sec: 0.0,
  end_sec: 3.5,
  text: 'Hello world, this is a test segment.',
  translation: 'Xin chào thế giới, đây là câu thử nghiệm.',
  tts_audio_id: null,
})

await insert('transcript_segments', {
  id: 'seg-empty-trans',
  project_id: projectId,
  index_num: 1,
  start_sec: 3.5,
  end_sec: 6.0,
  text: 'Good morning everyone.',
  translation: '',
  tts_audio_id: null,
})

const app = express()
app.use(express.json())
app.use('/api/v1/projects', projectsRouter)

const server = app.listen(0)
await once(server, 'listening')
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/api/v1/projects`

let failures = 0
function assert(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`)
  } else {
    failures++
    console.error(`FAIL: ${message}`)
  }
}

try {
  // Test 1: POST /projects/:id/segments/:segmentId/retranslate - 200 OK
  {
    const res = await fetch(`${baseUrl}/${projectId}/segments/seg-1/retranslate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    assert(res.status === 200, `POST retranslate returns 200 OK (got ${res.status})`)
    assert(data.success === true, 'POST retranslate response has success=true')
    assert(typeof data.translation === 'string' && data.translation.length > 0, `POST retranslate returned valid translation: "${data.translation}"`)
    assert(data.revision > 1, `POST retranslate bumped revision to ${data.revision}`)

    const updatedDb = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['seg-1'])
    assert(updatedDb.translation === data.translation, 'Database segment translation was updated')
  }

  // Test 2: POST /projects/:id/segments/non-existent/retranslate - 404
  {
    const res = await fetch(`${baseUrl}/${projectId}/segments/non-existent-seg/retranslate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert(res.status === 404, `POST retranslate for non-existent segment returns 404 (got ${res.status})`)
  }

  // Test 3: POST /projects/:id/segments/:segmentId/redub - 200 OK
  {
    const res = await fetch(`${baseUrl}/${projectId}/segments/seg-1/redub`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    assert(res.status === 200, `POST redub returns 200 OK (got ${res.status})`)
    assert(data.success === true, 'POST redub response has success=true')
    assert(Boolean(data.audioId), `POST redub returned audioId: ${data.audioId}`)

    const updatedDb = await queryOne('SELECT * FROM transcript_segments WHERE id = ?', ['seg-1'])
    assert(updatedDb.tts_audio_id === data.audioId, 'Database segment tts_audio_id was updated')

    const audioRow = await queryOne('SELECT * FROM audios WHERE id = ?', [data.audioId])
    assert(Boolean(audioRow), 'Audios table has corresponding audio record')
  }

  // Test 4: POST /projects/:id/segments/:segmentId/redub - 400 for segment without translation
  {
    const res = await fetch(`${baseUrl}/${projectId}/segments/seg-empty-trans/redub`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert(res.status === 400, `POST redub for segment with empty translation returns 400 (got ${res.status})`)
  }

  // Test 5: POST /projects/:id/segments/non-existent/redub - 404
  {
    const res = await fetch(`${baseUrl}/${projectId}/segments/non-existent-seg/redub`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert(res.status === 404, `POST redub for non-existent segment returns 404 (got ${res.status})`)
  }

} finally {
  server.close()
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (_) {}
}

console.log(failures === 0 ? '\nALL TESTS PASSED (100% OK)' : `\n${failures} TESTS FAILED`)
process.exit(failures === 0 ? 0 : 1)
