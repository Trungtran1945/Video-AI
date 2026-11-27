import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { query, updateById } from '../../db/query.js'
import { listProvidersForCapability } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { withProviderFailover } from '../../lib/providerFailover.js'
import { packSegment, buildTimelineRows, textEmbedding } from '../alignService.js'
import { projectDir, ensureDir, parseJsonSafe, toStorageKey, round2, insertMany } from '../context.js'

export async function summaryAlign(ctx) {
  const { project, job, setProgress, signal } = ctx
  const segments = await query(
    'SELECT * FROM script_segments WHERE project_id = ? ORDER BY index_num ASC',
    [project.id]
  )
  if (!segments.length) {
    throw new Error('Chưa có kịch bản — hãy retry từ stage summary.script')
  }
  const scenesRows = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
  if (!scenesRows.length) {
    throw new Error('Chưa có cảnh nào — hãy retry từ stage summary.sceneDetect')
  }
  const scenesById = new Map(scenesRows.map((s) => [s.id, s]))

  // Demo mode thêm mock vào cuối danh sách: nếu Edge-TTS không có mạng thì
  // pipeline vẫn render được (giọng im lặng). Provider thật vẫn đứng đầu.
  const ttsCandidates = await listProvidersForCapability(project.user_id, 'tts')
  if (!ttsCandidates.length) throw new Error('NO_PROVIDER_AVAILABLE: chưa có provider TTS nào')
  const audioDir = ensureDir(path.join(projectDir(project.id), 'audio'))
  const usedSceneIds = new Set()
  const segmentsMeta = []
  const audioRows = []

  for (const seg of segments) {
    // Check abort signal
    if (signal?.aborted) throw new Error('Cancelled')
    setProgress(3 + Math.round((segmentsMeta.length / segments.length) * 55))
    const outPath = path.join(audioDir, `seg_${seg.index_num}.mp3`)
    const { result: synth, provider: usedTts } = await withProviderFailover(
      { capability: 'tts', candidates: ttsCandidates, maxAttempts: ttsCandidates.length },
      async (cand) => callProvider({
        provider: cand.id,
        type: 'tts',
        model: cand.provider.model || cand.id,
        input: { text: seg.narration, outPath },
        fn: () => cand.provider.synthesize({ text: seg.narration, outPath }),
        userId: project.user_id,
        apiKeyId: cand.apiKeyId,
        projectId: project.id,
        jobId: job.id,
      })
    )

    const refs = (parseJsonSafe(seg.scene_refs, []) || [])
      .map((r) => ({ scene: scenesById.get(r.sceneId), weight: Number(r.weight) || 0.6 }))
      .filter((r) => r.scene)
      .sort((a, b) => b.weight - a.weight)

    const packed = packSegment({
      candidates: refs,
      targetDurationSec: synth.durationSec || seg.target_duration_sec,
      extraPool: scenesRows,
      segmentVec: textEmbedding(seg.narration),
    })
    if (!packed.chosen.length) {
      throw new Error(`Không gói được cảnh nào cho segment ${seg.index_num}`)
    }
    for (const c of packed.chosen) usedSceneIds.add(c.scene.id)

    const duration = synth.durationSec || 1
    const audioRow = {
      id: uuidv4(),
      project_id: project.id,
      kind: 'voice',
      storage_key: toStorageKey(synth.audioPath),
      duration_sec: round2(duration),
      provider: usedTts.id,
    }
    audioRows.push(audioRow)
    segmentsMeta.push({
      segmentId: seg.id,
      index: seg.index_num,
      audioId: audioRow.id,
      audioPath: synth.audioPath,
      narration: seg.narration,
      durationSec: round2(duration),
      speed: packed.speed,
      clips: packed.chosen,
    })
  }

  if (audioRows.length) await insertMany('audios', audioRows)

  const clipRows = buildTimelineRows(segmentsMeta).map((row) => ({ id: uuidv4(), project_id: project.id, ...row }))
  await insertMany('timeline_clips', clipRows)

  for (const sm of segmentsMeta) {
    await updateById('script_segments', sm.segmentId, { voice_audio_id: sm.audioId })
    delete sm.clips
    delete sm.audioPath
  }
  setProgress(96)

  return {
    segmentsMeta,
    clipCount: clipRows.length,
    totalDurationSec: clipRows.length
      ? round2(clipRows[clipRows.length - 1].start_at_sec + (clipRows[clipRows.length - 1].out_sec - clipRows[clipRows.length - 1].in_sec) / clipRows[clipRows.length - 1].speed)
      : 0,
  }
}

export default summaryAlign
