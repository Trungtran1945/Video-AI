/**
 * Express middleware that validates req.body, req.query, and/or req.params using Zod schemas.
 * Replaces request target with parsed/sanitized result on success.
 * Returns 400 Bad Request with field-level details on validation failure.
 *
 * @param {Object} schemas
 * @param {import('zod').ZodSchema} [schemas.body]
 * @param {import('zod').ZodSchema} [schemas.query]
 * @param {import('zod').ZodSchema} [schemas.params]
 * @returns {Function} Express middleware (req, res, next)
 */
export function validate({ body, query, params } = {}) {
  return (req, res, next) => {
    const errors = []

    if (body) {
      const result = body.safeParse(req.body)
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            target: 'body',
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })
        }
      } else {
        req.body = result.data
      }
    }

    if (query) {
      const result = query.safeParse(req.query)
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            target: 'query',
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })
        }
      } else {
        req.query = result.data
      }
    }

    if (params) {
      const result = params.safeParse(req.params)
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            target: 'params',
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })
        }
      } else {
        req.params = result.data
      }
    }

    if (errors.length > 0) {
      const firstError = errors[0]
      const fieldName = firstError.field || firstError.target
      const message = `${fieldName}: ${firstError.message}`
      return res.status(400).json({
        code: 'INVALID_INPUT',
        message,
        field: firstError.field,
        errors,
        error: {
          code: 'INVALID_INPUT',
          message: 'Validation failed',
          details: errors,
        },
      })
    }

    next()
  }
}

export function validateBody(schema) {
  return validate({ body: schema })
}

export function validateQuery(schema) {
  return validate({ query: schema })
}

export function validateParams(schema) {
  return validate({ params: schema })
}

export default {
  validate,
  validateBody,
  validateQuery,
  validateParams,
}
