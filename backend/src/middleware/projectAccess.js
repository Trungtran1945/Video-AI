import { queryOne } from '../db/query.js'
import { sendError, ERR } from '../lib/httpError.js'

// Loads :id project param and enforces ownership (owner or admin).
// Attaches the row to req.project. 404 hides existence from strangers.
export function requireProjectOwner(req, res, next) {
  loadProject()(req, res, next)
}

// Same check but for routes where the id is an output id; attaches req.output
// and req.project when resolvable.
export async function requireOutputOwner(req, res, next) {
  const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [req.params.id])
  if (!output) return sendError(res, 404, 'NOT_FOUND', 'Output not found')
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id])
  if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
  if (project.user_id !== req.user.id && req.user.role !== 'admin') {
    return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
  }
  req.output = output
  req.project = project
  next()
}

function loadProject() {
  return async (req, res, next) => {
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    req.project = project
    next()
  }
}

export default { requireProjectOwner, requireOutputOwner }
