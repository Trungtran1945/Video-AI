import fs from 'node:fs'
import { query, run } from '../../db/query.js'
import { isProjectRunOwned, updateProjectOwned } from '../../services/projectAdmission.js'
import { resolveStorageKey, round2 } from '../context.js'
import composerService from '../../services/composerService.js'

async function assertRunOwner(projectId, runToken) {
  if (runToken && !(await isProjectRunOwned(projectId, runToken))) {
    const error = new Error('RUN_ABORTED')
    error.code = 'RUN_ABORTED'
    throw error
  }
}

export async function composerIngest(ctx = {}) {
  const { project, setProgress = () => {}, signal, runToken } = ctx
  if (runToken) await assertRunOwner(project.id, runToken)
  if (signal?.aborted) throw new Error('Cancelled')

  setProgress(10)

  // 1. Check if timeline has clips. If not, auto arrange.
  let clips = await query(
    'SELECT * FROM timeline_clips WHERE project_id = ? ORDER BY order_index ASC',
    [project.id]
  )

  if (clips.length === 0) {
    // Attempt auto-arrange
    const arranged = await composerService.autoArrangeTimeline({ projectId: project.id })
    clips = arranged.clips || []
  }

  if (clips.length === 0) {
    throw new Error('Dự án chưa có clips trên timeline và chưa có tư liệu hình ảnh. Hãy tải tư liệu vào Thư viện trước khi xuất video.')
  }

  setProgress(30)
  await assertRunOwner(project.id, runToken)

  // 2. Validate that referenced assets/audios exist
  const assetIds = [...new Set(clips.map((c) => c.asset_id).filter(Boolean))]
  const assets = assetIds.length
    ? await query('SELECT * FROM assets WHERE project_id = ?', [project.id])
    : []
  const assetMap = new Map(assets.map((a) => [a.id, a]))

  const audioIds = [...new Set(clips.map((c) => c.audio_id).filter(Boolean))]
  const audios = audioIds.length
    ? await query('SELECT * FROM audios WHERE project_id = ?', [project.id])
    : []
  const audioMap = new Map(audios.map((a) => [a.id, a]))

  for (const c of clips) {
    if (signal?.aborted) throw new Error('Cancelled')

    if (c.asset_id) {
      const a = assetMap.get(c.asset_id)
      if (a) {
        const abs = resolveStorageKey(a.storage_key)
        if (!abs || !fs.existsSync(abs)) {
          console.warn(`[composerIngest] Asset file missing for clip ${c.id}: ${a.storage_key}`)
        }
      }
    }

    if (c.audio_id) {
      const aud = audioMap.get(c.audio_id)
      if (aud) {
        const abs = resolveStorageKey(aud.storage_key)
        if (!abs || !fs.existsSync(abs)) {
          console.warn(`[composerIngest] Audio file missing for clip ${c.id}: ${aud.storage_key}`)
        }
      }
    }
  }

  setProgress(60)
  await assertRunOwner(project.id, runToken)

  // 3. Compute duration
  let maxEndSec = 0
  for (const c of clips) {
    const end = (Number(c.start_at_sec) || 0) + Math.max(0, Number(c.out_sec) - Number(c.in_sec || 0))
    if (end > maxEndSec) maxEndSec = end
  }
  const totalDuration = round2(Math.max(1, maxEndSec))

  // Update target_duration_sec
  if (runToken) {
    await updateProjectOwned(project.id, runToken, { target_duration_sec: Math.round(totalDuration) })
  } else {
    await run('UPDATE projects SET target_duration_sec = ? WHERE id = ?', [Math.round(totalDuration), project.id])
  }

  setProgress(100)
  return {
    clipsCount: clips.length,
    durationSec: totalDuration,
  }
}

export default composerIngest
