import { queryOne, run } from '../db/query.js'

/**
 * ConfirmPreviewUseCase — FR-J2
 * Runs after dub.translate, before dub.ttsAlign/dub.render.
 */
export async function confirmPreviewUseCase(projectId) {
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
  if (!project) throw new Error('Project not found')

  const mode = String(project.mode || '').toUpperCase().replace('-', '_')
  if (mode !== 'TRANSLATE_DUB') {
    const err = new Error('Confirm preview chỉ khả dụng cho project TRANSLATE_DUB')
    err.code = 'VALIDATION'
    throw err
  }

  const translateJob = await queryOne(
    `SELECT id, status FROM generation_jobs WHERE project_id = ? AND type = 'dub.translate'`,
    [projectId]
  )
  if (!translateJob || translateJob.status !== 'success') {
    const err = new Error('dub.translate chưa hoàn thành')
    err.code = 'VALIDATION'
    throw err
  }

  const params = project.params ? JSON.parse(project.params) : {}
  params.previewConfirmed = true
  params.previewConfirmedAt = new Date().toISOString()
  await run(`UPDATE projects SET params = ? WHERE id = ?`, [JSON.stringify(params), projectId])

  return { message: 'Preview confirmed, render queued', projectId }
}

export default confirmPreviewUseCase
