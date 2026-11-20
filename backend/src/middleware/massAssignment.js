import {
  GLOBAL_FORBIDDEN_FIELDS,
  stripForbiddenFields,
  filterAllowedFields,
  getForbiddenFieldsPresent,
} from '../lib/sanitizePayload.js'
import { sendError } from '../lib/httpError.js'

/**
 * Middleware that guards against Mass Assignment / BOPLA.
 *
 * Usage:
 *   router.patch('/:id', protectFields(['user_id', 'status', 'role']), handler)
 *   router.patch('/:id', protectFields({ forbidden: ['role'], strict: true }), handler)
 */
export function protectFields(optionsOrFields = {}) {
  let forbidden = GLOBAL_FORBIDDEN_FIELDS
  let explicitStrict = null

  if (Array.isArray(optionsOrFields)) {
    forbidden = optionsOrFields
  } else if (optionsOrFields && typeof optionsOrFields === 'object') {
    if (Array.isArray(optionsOrFields.forbidden)) {
      forbidden = optionsOrFields.forbidden
    }
    if (typeof optionsOrFields.strict === 'boolean') {
      explicitStrict = optionsOrFields.strict
    }
  }

  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      return next()
    }

    const strict = explicitStrict !== null
      ? explicitStrict
      : process.env.STRICT_MASS_ASSIGNMENT === 'true'

    const present = getForbiddenFieldsPresent(req.body, forbidden)
    if (present.length > 0) {
      if (strict) {
        return sendError(
          res,
          400,
          'FORBIDDEN_FIELD',
          `Modification of protected fields is not allowed: ${present.join(', ')}`,
          { fields: present }
        )
      }
      // Non-strict default: sanitize silently by stripping forbidden keys
      req.body = stripForbiddenFields(req.body, forbidden)
    }

    next()
  }
}

/**
 * Middleware that strictly allowlists properties on req.body.
 *
 * Usage:
 *   router.patch('/:id', allowOnly(['title', 'aspect_ratio', 'params']), handler)
 */
export function allowOnly(allowedFields = [], options = {}) {
  const explicitStrict = typeof options?.strict === 'boolean' ? options.strict : null

  return (req, res, next) => {
    if (!req.body || typeof req.body !== 'object') {
      return next()
    }

    const strict = explicitStrict !== null
      ? explicitStrict
      : process.env.STRICT_MASS_ASSIGNMENT === 'true'

    if (strict) {
      const allowedSet = new Set(allowedFields)
      const unallowed = Object.keys(req.body).filter((k) => !allowedSet.has(k))
      if (unallowed.length > 0) {
        return sendError(
          res,
          400,
          'UNALLOWED_FIELD',
          `Unallowed fields present in payload: ${unallowed.join(', ')}`,
          { fields: unallowed }
        )
      }
    }

    req.body = filterAllowedFields(req.body, allowedFields)
    next()
  }
}

export default {
  protectFields,
  allowOnly,
}
