import { claimQueuedProject as admitQueuedProject } from '../services/projectAdmission.js'

export async function claimQueuedProject(projectId, options = {}) {
  return admitQueuedProject(projectId, options)
}

export default { claimQueuedProject }
