import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { insert, updateById } from '../../db/query.js'
import { extractAudio, sliceAudio, probe, compressAudioForUpload } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, round2 } from '../context.js'

const CHUNK_SEC = 600

// dub.stt (docs/05 §B.2): ASR trên audio đã normalize LUFS → transcript_segments.
// Speaker diarization: cột speaker để NULL ở v1 (Whisper API không trả speaker).
export async function dubStt(ctx) {
  const { project, job, setProgress, results } = ctx
  const ingest = results['dub.ingest'] || {}
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  // Ưu tiên audio đã chuẩn hoá ở stage ingest; thiếu → tách lại từ nguồn
  let fullWav
  if (ingest.normalizedAudioKey) {
    const abs = path.join(projectDir(project.id), 'source_norm.wav')
    fullWav = fs.existsSync(abs) ? abs : null
  }
  let languageHint = ingest.language
  if (!fullWav) {
    const info = await probe(src)
    fullWav = path.join(tmp, `dub_raw_${project.id}.wav`)
    await extractAudio(src, fullWav)
    languageHint = undefined
    setProgress(6)
  }

  const durationSec = ingest.durationSec || (await probe(fullWav)).durationSec || (await probe(src)).durationSec

  const chunkCount = Math.max(1, Math.ceil(durationSec / CHUNK_SEC))
  const chunks = []
  if (chunkCount === 1) {
    chunks.push({ file: fullWav, offsetSec: 0 })
  } else {
    for (let i = 0; i < chunkCount; i++) {
      const start = i * CHUNK_SEC
      const dur = Math.min(CHUNK_SEC, durationSec - start)
      const f = path.join(tmp, `dub_chunk_${i}.wav`)
      await sliceAudio(fullWav, f, start, dur)
      chunks.push({ file: f, offsetSec: start })
      setProgress(5 + Math.round(((i + 1) / chunkCount) * 10))
    }
  }

  const asr = await getProvider(project.user_id, 'asr')
  let language = null
  const segments = []
  for (let i = 0; i < chunks.length; i++) {
    // Upload bản MP3 nén thay vì WAV gốc (tránh vượt giới hạn dung lượng của Groq)
    const uploadFile = path.join(tmp, `dub_up_${i}.mp3`)
    await compressAudioForUpload(chunks[i].file, uploadFile)
    const res = await tracked(
      { projectId: project.id, jobId: job.id, provider: asr.id, type: 'asr' },
      () => asr.provider.transcribe(uploadFile, { language: languageHint })
    )
    try { fs.unlinkSync(uploadFile) } catch (_) {}
    if (!language || language === 'unknown') language = res.language
    for (const s of res.segments || []) {
      segments.push({
        id: uuidv4(),
        project_id: project.id,
        index_num: segments.length,
        start_sec: round2(s.start + chunks[i].offsetSec),
        end_sec: round2(s.end + chunks[i].offsetSec),
        text: String(s.text || '').trim(),
        speaker: s.speaker ?? null,
        language: res.language || languageHint || null,
      })
    }
    setProgress(15 + Math.round(((i + 1) / chunks.length) * 82))
  }

  // Ghi DB (docs/02: TranscriptSegment) — chèn tuần tự để giữ thứ tự index
  for (const seg of segments) {
    await insert('transcript_segments', seg)
  }

  // Dọn chunk trung gian (giữ lại normalized wav cho TTS mixing nếu cần)
  for (const c of chunks) {
    if (c.file !== fullWav) {
      try { fs.unlinkSync(c.file) } catch (_) {}
    }
  }

  return {
    segmentCount: segments.length,
    language: language || null,
    speakerDiarized: segments.some((s) => s.speaker),
  }
}

export default dubStt
