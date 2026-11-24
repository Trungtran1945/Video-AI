/**
 * Canonical whitelist of all 34 valid application tables in Video_AI.
 * Protects against dynamic table injection in raw queries and CRUD helpers.
 */
export const ALLOWED_TABLES = new Set([
  'users',
  'projects',
  'assets',
  'outputs',
  'settings',
  'api_keys',
  'generation_jobs',
  'timeline_tracks',
  'timeline_clips',
  'scenes',
  'script_segments',
  'transcript_segments',
  'audios',
  'subtitles',
  'ocr_regions',
  'upload_sessions',
  'style_presets',
  'email_otps',
  'reset_tokens',
  'otp_codes',
  'provider_logs',
  'provider_rate_limits',
  'provider_cache',
  'project_cleanup_tasks',
  'project_glossaries',
  'project_idempotency',
  'script_uploads',
  'sse_tickets',
  'youtube_accounts',
  'youtube_oauth_states',
  'youtube_uploads',
  'schema_migrations',
  'cloudinary_assets',
  'media_migration_manifest',
])

/**
 * Validates that a table name is a non-empty string and belongs to the ALLOWED_TABLES whitelist.
 * Throws an Error if invalid.
 *
 * @param {string} table
 * @returns {string} Lowercase trimmed table name
 */
export function assertValidTable(table) {
  if (typeof table !== 'string') {
    throw new Error(`Invalid table name type: expected string, got ${typeof table}`)
  }
  const cleanTable = table.trim().toLowerCase()
  if (!cleanTable || !ALLOWED_TABLES.has(cleanTable)) {
    throw new Error(`Invalid or unauthorized table name: "${table}"`)
  }
  return cleanTable
}

/**
 * Validates that a column name consists strictly of alphanumeric characters and underscores [a-zA-Z0-9_].
 * Rejects whitespace, quotes, dashes, semicolons, comments, or other SQL injection vectors.
 *
 * @param {string} col
 * @returns {string} Validated column name
 */
export function assertValidColumnName(col) {
  if (typeof col !== 'string' || !/^[a-zA-Z0-9_]+$/.test(col)) {
    throw new Error(`Invalid or unsafe column name: "${col}"`)
  }
  return col
}

/**
 * Safely constructs an ORDER BY clause by verifying the requested column against a whitelist
 * and strictly enforcing 'ASC' or 'DESC' direction.
 *
 * @param {string} [sortColumn] - Requested column name
 * @param {string} [sortDirection='DESC'] - Requested sort direction
 * @param {string[]|Set<string>} allowedColumns - Whitelist of permitted column names
 * @param {string} [defaultSort='created_date DESC'] - Fallback sort clause
 * @returns {string} Safe SQL ORDER BY clause
 */
export function buildSafeOrderBy(sortColumn, sortDirection, allowedColumns = [], defaultSort = 'created_date DESC') {
  if (!sortColumn || typeof sortColumn !== 'string') {
    return defaultSort
  }
  const cleanCol = sortColumn.trim().toLowerCase()
  const allowedSet = allowedColumns instanceof Set
    ? allowedColumns
    : new Set(Array.isArray(allowedColumns) ? allowedColumns.map((c) => String(c).toLowerCase()) : [])

  if (!allowedSet.has(cleanCol)) {
    return defaultSort
  }

  const rawDir = typeof sortDirection === 'string' ? sortDirection.trim().toUpperCase() : 'DESC'
  const cleanDir = rawDir === 'ASC' ? 'ASC' : 'DESC'

  return `"${cleanCol}" ${cleanDir}`
}

/**
 * Validates and constrains pagination parameters (limit and offset).
 * Prevents negative offsets, non-numeric inputs, and resource exhaustion via excessive limits.
 *
 * @param {number|string} [limit=20] - Number of items to return
 * @param {number|string} [offset=0] - Number of items to skip
 * @param {number} [maxLimit=100] - Maximum allowed limit
 * @returns {{ limit: number, offset: number }} Sanitized pagination values
 */
export function validatePagination(limit, offset, maxLimit = 100) {
  const parsedLimit = parseInt(limit, 10)
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.max(1, Math.min(maxLimit, parsedLimit))
    : 20

  const parsedOffset = parseInt(offset, 10)
  const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0
    ? parsedOffset
    : 0

  return { limit: safeLimit, offset: safeOffset }
}
