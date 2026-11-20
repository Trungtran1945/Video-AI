import { queryOne } from '../db/query.js'
import { sendError, ERR } from '../lib/httpError.js'

/**
 * Checks whether existence of resources should be masked with 404 rather than 403.
 * Configurable via options.hideExistence or env var STRICT_IDOR_404.
 */
export function shouldHideExistence(options = {}) {
  return Boolean(options.hideExistence) || process.env.STRICT_IDOR_404 === 'true'
}

/**
 * Loads project by :id or :projectId and enforces ownership (owner or admin).
 * Attaches the row to req.project.
 * Supports both direct middleware: requireProjectOwner(req, res, next)
 * and parameterized factory: requireProjectOwner({ hideExistence: true })(req, res, next)
 */
export function requireProjectOwner(optionsOrReq, maybeRes, maybeNext) {
  if (maybeRes && typeof maybeNext === 'function') {
    // Called directly as Express middleware: requireProjectOwner(req, res, next)
    return loadProject({})(optionsOrReq, maybeRes, maybeNext)
  }
  // Called as middleware factory: requireProjectOwner(options)
  return loadProject(optionsOrReq || {})
}

/**
 * Enforces ownership on outputs; attaches req.output and req.project.
 * Supports direct middleware: requireOutputOwner(req, res, next)
 * and factory: requireOutputOwner({ hideExistence: true })
 */
export function requireOutputOwner(optionsOrReq, maybeRes, maybeNext) {
  if (maybeRes && typeof maybeNext === 'function') {
    return loadOutput({})(optionsOrReq, maybeRes, maybeNext)
  }
  return loadOutput(optionsOrReq || {})
}

function loadProject(options = {}) {
  return async (req, res, next) => {
    const projectId = req.params.id || req.params.projectId
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      if (shouldHideExistence(options)) {
        return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
      }
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    req.project = project
    next()
  }
}

function loadOutput(options = {}) {
  return async (req, res, next) => {
    const outputId = req.params.id || req.params.outputId
    const output = await queryOne('SELECT * FROM outputs WHERE id = ?', [outputId])
    if (!output) return sendError(res, 404, 'NOT_FOUND', 'Output not found')
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [output.project_id])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      if (shouldHideExistence(options)) {
        return sendError(res, 404, 'NOT_FOUND', 'Output not found')
      }
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    req.output = output
    req.project = project
    next()
  }
}

export default { requireProjectOwner, requireOutputOwner, shouldHideExistence }
