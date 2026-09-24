import { createProjectWithAdmission } from '../services/projectAdmission.js'
import { runPipeline } from '../pipeline/runner.js'
import { v4 as uuidv4 } from 'uuid'

export async function createProjectUseCase(userId, data) {
  if (data.copyrightAcknowledged !== true) {
    const error = new Error('Bạn phải xác nhận quyền sử dụng nội dung nguồn trước khi tạo project')
    error.code = 'COPYRIGHT_001'
    throw error
  }

  const result = await createProjectWithAdmission({
    id: uuidv4(),
    userId,
    mode: data.mode,
    title: data.title,
    language: data.language || 'vi',
    style: data.style || null,
    targetDurationSec: data.targetDurationSec || 60,
    aspectRatio: data.aspectRatio || '16:9',
    params: data.params || {},
    sourceVideoKey: data.sourceVideoKey || null,
    videoHash: data.videoHash || null,
    copyrightAcknowledged: true,
  })
  if (result.admitted) {
    runPipeline(result.project.id, null, result.runToken).catch(() => {})
  }
  return result.project
}

export default createProjectUseCase
