import { queryOne } from '../db/query.js'
import { sendError, ERR } from '../lib/httpError.js'
import {
  requireProjectOwner,
  requireOutputOwner,
  shouldHideExistence,
} from './projectAccess.js'

/**
 * Validates ownership of an asset.
 * Checks asset existence and ensures parent project belongs to req.user.id (or admin).
 */
export function requireAssetOwner(optionsOrReq, maybeRes, maybeNext) {
  if (maybeRes && typeof maybeNext === 'function') {
    return loadAsset({})(optionsOrReq, maybeRes, maybeNext)
  }
  return loadAsset(optionsOrReq || {})
}

function loadAsset(options = {}) {
  return async (req, res, next) => {
    const assetId = req.params.assetId || req.params.id
    const asset = await queryOne('SELECT * FROM assets WHERE id = ?', [assetId])
    if (!asset) return sendError(res, 404, 'NOT_FOUND', 'Asset not found')
    const project = await queryOne('SELECT * FROM projects WHERE id = ?', [asset.project_id])
    if (!project) return sendError(res, 404, ERR.PROJECT_NOT_FOUND, 'Project not found')
    if (project.user_id !== req.user.id && req.user.role !== 'admin') {
      if (shouldHideExistence(options)) {
        return sendError(res, 404, 'NOT_FOUND', 'Asset not found')
      }
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    req.asset = asset
    req.project = project
    next()
  }
}

/**
 * Validates ownership of an API Key.
 * Ensures the API key belongs directly to req.user.id (or admin).
 */
export function requireApiKeyOwner(optionsOrReq, maybeRes, maybeNext) {
  if (maybeRes && typeof maybeNext === 'function') {
    return loadApiKey({})(optionsOrReq, maybeRes, maybeNext)
  }
  return loadApiKey(optionsOrReq || {})
}

function loadApiKey(options = {}) {
  return async (req, res, next) => {
    const keyId = req.params.id
    const apiKey = await queryOne('SELECT * FROM api_keys WHERE id = ?', [keyId])
    if (!apiKey) return sendError(res, 404, 'NOT_FOUND', 'API key not found')
    if (apiKey.user_id !== req.user.id && req.user.role !== 'admin') {
      if (shouldHideExistence(options)) {
        return sendError(res, 404, 'NOT_FOUND', 'API key not found')
      }
      return sendError(res, 403, ERR.AUTH_FORBIDDEN, 'Forbidden')
    }
    req.apiKey = apiKey
    next()
  }
}

/**
 * Pure assertion helper for non-middleware contexts.
 * Returns true if owned/admin, false or throws if forbidden/missing.
 */
export function assertResourceOwnership(resource, user, options = {}) {
  if (!resource) {
    const err = new Error('Resource not found')
    err.code = 'NOT_FOUND'
    err.statusCode = 404
    throw err
  }
  const isOwner = String(resource.user_id) === String(user.id)
  const isAdmin = user.role === 'admin'
  if (!isOwner && !isAdmin) {
    const hide = shouldHideExistence(options)
    const err = new Error(hide ? 'Resource not found' : 'Forbidden')
    err.code = hide ? 'NOT_FOUND' : 'FORBIDDEN'
    err.statusCode = hide ? 404 : 403
    throw err
  }
  return true
}

export {
  requireProjectOwner,
  requireOutputOwner,
  shouldHideExistence,
}

export default {
  requireProjectOwner,
  requireOutputOwner,
  requireAssetOwner,
  requireApiKeyOwner,
  assertResourceOwnership,
  shouldHideExistence,
}
