import path from 'path'
import fs from 'node:fs'
import { updateById } from '../../db/query.js'
import { probe, extractAudio, normalizeLoudness } from '../../media/mediaService.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, toStorageKey } from '../context.js'

// dub.ingest (docs/05 §B.1): demux + chuẩn hoá LUFS cho STT.
export async function dubIngest(ctx) {
  const { project, setProgress } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const tmp = ensureDir(tmpDirOf(project.id))
  const dir = ensureDir(projectDir(project.id))
  setProgress(5)

  const info = await probe(src)
  if (!info.durationSec) throw new Error('Không đọc được thời lượng video nguồn')

  // Cập nhật duration thật của dự án (docs/02: TRANSLATE_DUB target = duration nguồn)
  await updateById('projects', project.id, { target_duration_sec: Math.round(info.durationSec) })
  setProgress(15)

  // Tách audio 16kHz mono cho ASR
  const rawWav = path.join(tmp, `dub_raw_${project.id}.wav`)
  await extractAudio(src, rawWav)
  setProgress(45)

  // Chuẩn hoá −16 LUFS (docs/07 §2.12) → STT chính xác hơn.
  // Lưu ở project dir để các stage sau resolve được qua storage key.
  const normWav = path.join(dir, 'source_norm.wav')
  try {
    await normalizeLoudness(rawWav, normWav)
  } catch (err) {
    console.warn('[dubIngest] loudnorm thất bại, dùng audio thô:', err.message.slice(0, 160))
    fs.copyFileSync(rawWav, normWav)
  }
  try { fs.unlinkSync(rawWav) } catch (_) {}
  setProgress(90)

  return {
    durationSec: Math.round(info.durationSec * 100) / 100,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    normalizedAudioKey: toStorageKey(normWav),
    language: paramsLanguage(project),
  }
}

function paramsLanguage(project) {
  let p = {}
  try { p = project.params ? JSON.parse(project.params) : {} } catch (_) {}
  return p.sourceLanguage && p.sourceLanguage !== 'auto' ? p.sourceLanguage : undefined
}

export default dubIngest
