import path from 'path'
import { query, run } from '../../db/query.js'
import { makeThumbnail } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { textEmbedding } from '../alignService.js'
import { projectDir, ensureDir, requireSourceFile, toStorageKey } from '../context.js'

export function selectKeyScenes(rows) {
  if (rows.length <= 24) return rows.slice()
  const k = Math.min(40, Math.max(8, Math.round(rows.length * 0.2)))
  const bucketSize = rows.length / k
  const picked = []
  for (let b = 0; b < k; b++) {
    const slice = rows.slice(Math.floor(b * bucketSize), Math.floor((b + 1) * bucketSize))
    if (!slice.length) continue
    let longest = slice[0]
    for (const s of slice) {
      if (s.end_sec - s.start_sec > longest.end_sec - longest.start_sec) longest = s
    }
    picked.push(longest)
  }
  return picked
}

export async function summaryAnalyze(ctx) {
  const { project, job, setProgress, signal } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn (phim)')
  const rows = await query('SELECT * FROM scenes WHERE project_id = ? ORDER BY start_sec ASC', [project.id])
  if (!rows.length) {
    throw new Error('Chưa có cảnh nào — hãy retry từ stage summary.sceneDetect')
  }

  // Check abort signal
  if (signal?.aborted) throw new Error('Cancelled')

  const keys = selectKeyScenes(rows)
  const vision = await getProvider(project.user_id, 'vision')
  const thumbsDir = ensureDir(path.join(projectDir(project.id), 'thumbs'))
  setProgress(5)

  let done = 0
  const BATCH_SIZE = 5
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE)

    // Generate all thumbnails in parallel
    const thumbEntries = await Promise.all(batch.map(scene => {
      const thumbPath = path.join(thumbsDir, `${scene.id}.jpg`)
      return makeThumbnail(src, (scene.start_sec + scene.end_sec) / 2, thumbPath)
        .then(() => ({ scene, thumbPath }))
    }))

    // Single callProvider call — if provider supports batch, use it;
    // otherwise sequential within one call for caching benefit
    const results = await callProvider({
      provider: vision.id,
      type: 'vision',
      model: vision.provider.model || vision.id,
      input: { imagePaths: thumbEntries.map(t => t.thumbPath) },
      fn: async () => {
        if (typeof vision.provider.describeBatch === 'function') {
          return vision.provider.describeBatch({ imagePaths: thumbEntries.map(t => t.thumbPath) })
        }
        return Promise.all(thumbEntries.map(t =>
          vision.provider.describeImage({ imagePath: t.thumbPath })
        ))
      },
      userId: project.user_id,
      apiKeyId: vision.apiKeyId,
      projectId: project.id,
      jobId: job.id,
    })

    const describedList = Array.isArray(results) ? results : [results]
    for (let j = 0; j < batch.length; j++) {
      const described = describedList[j]
      await run(`UPDATE scenes SET thumbnail_key = ?, description = ?, embedding = ? WHERE id = ?`, [
        toStorageKey(thumbEntries[j].thumbPath),
        described.text.slice(0, 500),
        JSON.stringify(textEmbedding(described.text)),
        batch[j].id,
      ])
      done++
      setProgress(5 + Math.round((done / keys.length) * 92))
    }
  }

  return { keySceneCount: done }
}

export default summaryAnalyze
