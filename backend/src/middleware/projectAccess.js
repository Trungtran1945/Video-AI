import { queryOne } from '../db/query.js'

// Loads :id project param and enforces ownership (owner or admin).
// Attaches the row to req.project. 404 hides existence from strangers.
export function requireProjectOwner(req, res, next) {
  loadProject()(req, res, next)
}

// Same check but for routes where the id is an output id; attaches req.output
// and req.project when resolvable.
export async function requireOutputOwner(req, res, next) {
  const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [req.params.id])
  if (!output) return res.status(404).json({ message: 'Output not found', code: 'NOT_FOUND' })
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id])
  if (!project) return res.status(404).json({ message: 'Project not found', code: 'NOT_FOUND' })
  if (project.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' })
  }
  req.output = output
  req.project = project
  next()
}

function loadProject() {
  return async (req, res, next) => {
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [req.params.id])
    if (!project) return res.status(404).json({ message: 'Project not found', code: 'PROJ_001' })
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Forbidden', code: 'AUTH_002' })
    }
    req.project = project
    next()
  }
}

export default { requireProjectOwner, requireOutputOwner }
