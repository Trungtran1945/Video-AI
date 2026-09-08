import { queryOne, run } from '../db/query.js'

/**
 * ConfirmPreviewUseCase — FR-J2
 * Runs after dub.translate, before dub.ttsAlign/dub.render.
 * Optional body: { regions: [...] } to update mask regions before final render.
 */
export async function confirmPreviewUseCase(projectId, regions = null) {
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')

  // Verify mode is TRANSLATE_DUB
  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  if (mode !== 'TRANSLATE_DUB') {
    const err = new Error('Confirm preview chỉ khả dụng cho project TRANSLATE_DUB')
    err.code = 'VALIDATION'
    throw err
  }

  // Check that dub.translate has completed
  const translateJob = await queryOne(
    `SELECT id, status FROM generation_jobs WHERE project_id = ? AND type = 'dub.translate'`,
    [projectId]
  )
  if (!translateJob || translateJob.status !== 'success') {
    const err = new Error('dub.translate chưa hoàn thành')
    err.code = 'VALIDATION'
    throw err
  }

  // Update mask regions if provided
  if (Array.isArray(regions)) {
    for (const r of regions) {
      if (r.id) {
        await run(
          `UPDATE ocr_regions SET ratio_x = ?, ratio_y = ?, ratio_w = ?, ratio_h = ?, mask_strength = ?
           WHERE id = ? AND project_id = ?`,
          [r.ratioX, r.ratioY, r.ratioW, r.ratioH, r.maskStrength ?? 0.6, r.id, projectId]
        )
      }
    }
  }

  // Mark confirm preview step in params
  const params = project.params ? JSON.parse(project.params) : {}
  params.previewConfirmed = true
  params.previewConfirmedAt = new Date().toISOString()
  await run(`UPDATE projects SET params = ? WHERE id = ?`, [JSON.stringify(params), projectId])

  return { message: 'Preview confirmed, render queued', projectId }
}

export default confirmPreviewUseCase
