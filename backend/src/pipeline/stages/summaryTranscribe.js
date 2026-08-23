import fs from 'node:fs'
import path from 'path'
import { extractAudio, sliceAudio, probe } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, writeJson, toStorageKey, round2 } from '../context.js'

const CHUNK_SEC = 600

export async function summaryTranscribe(ctx) {
  const { project, job, setProgress } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn (phim)')
  const dir = projectDir(project.id)
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  const info = await probe(src)
  if (!info.durationSec) throw new Error('Không đọc được thời lượng video nguồn')

  const fullWav = path.join(tmp, 'source_full.wav')
  const chunkCount = Math.max(1, Math.ceil(info.durationSec / CHUNK_SEC))
  const chunks = []
  if (chunkCount === 1) {
    chunks.push({ file: await extractAudio(src, fullWav), offsetSec: 0 })
  } else {
    await extractAudio(src, fullWav)
    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SEC
      const dur = Math.min(CHUNK_SEC, info.durationSec - start)
      const f = path.join(tmp, `chunk_${i}.wav`)
      await sliceAudio(fullWav, f, start, dur)
      chunks.push({ file: f, offsetSec: start })
      setProgress(2 + Math.round(((i + 1) / chunkCount) * 8))
    }
  }

  const asr = await getProvider(project.user_id, 'asr')
  let language = null
  const segments = []
  for (let i = 0; i < chunks.length; i++) {
    const res = await tracked(
      { projectId: project.id, jobId: job.id, provider: asr.id, type: 'asr' },
      () => asr.provider.transcribe(chunks[i].file, { language: project.language || undefined })
    )
    if (!language || language === 'unknown') language = res.language
    for (const s of res.segments) {
      segments.push({
        start: round2(s.start + chunks[i].offsetSec),
        end: round2(s.end + chunks[i].offsetSec),
        text: s.text,
      })
    }
    setProgress(12 + Math.round(((i + 1) / chunks.length) * 84))
  }

  const transcriptPath = writeJson(path.join(dir, 'transcript.json'), {
    language: language || project.language || 'unknown',
    durationSec: info.durationSec,
    segments,
  })

  try { fs.unlinkSync(fullWav) } catch (_) {}
  for (const c of chunks) {
    if (c.file !== fullWav) {
      try { fs.unlinkSync(c.file) } catch (_) {}
    }
  }

  return {
    transcriptKey: toStorageKey(transcriptPath),
    language: language || null,
    segmentCount: segments.length,
    durationSec: round2(info.durationSec),
  }
}

export default summaryTranscribe
