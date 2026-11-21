/**
 * OWASP ASVS L2 / SEC-10 Data Minimization and Response Sanitization.
 * Enforces recursive stripping of sensitive credentials, secrets, tokens,
 * and internal server paths from all outgoing API responses and DTOs.
 */

export const SENSITIVE_RESPONSE_FIELDS = Object.freeze(new Set([
  // Passwords & hashes
  'password',
  'password_hash',
  'passwordhash',
  'salt',
  // Session & Refresh tokens
  'refresh_token',
  'refreshtoken',
  'refresh_token_hash',
  'refreshtokenhash',
  'refresh_expires',
  'refreshexpires',
  // Reset & verification tokens
  'reset_token',
  'resettoken',
  'reset_token_hash',
  'resettokenhash',
  'reset_expires',
  'resetexpires',
  'verification_token',
  'verificationtoken',
  // OTP secrets & hashes
  'otp_hash',
  'otphash',
  'otp_code',
  'otpcode',
  // Encryption keys & secrets
  'encrypted_key',
  'encryptedkey',
  'master_key',
  'masterkey',
  'secret_key',
  'secretkey',
  'api_key_secret',
  'apikeysecret',
  'token_secret',
  'tokensecret',
  // Internal server diagnostics & error stacks
  'stack',
  'stacktrace',
  'query_text',
  'querytext',
  'database_url',
  'databaseurl',
  'db_connection_string',
]))

/**
 * Checks if an object key name is considered sensitive.
 * Performs case-insensitive and delimiter-agnostic check.
 *
 * @param {string} key - Property key to check
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  if (typeof key !== 'string' || !key) return false
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  if (SENSITIVE_RESPONSE_FIELDS.has(key.toLowerCase()) || SENSITIVE_RESPONSE_FIELDS.has(normalized)) {
    return true
  }
  // Check common sensitive prefixes/suffixes
  if (
    normalized.endsWith('password') ||
    normalized.endsWith('passwordhash') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('resettoken') ||
    normalized.endsWith('encryptedkey') ||
    normalized.endsWith('masterkey')
  ) {
    return true
  }
  return false
}

/**
 * Redacts absolute server paths and database connection strings from text.
 *
 * @param {string} text - Raw string
 * @returns {string} Clean string
 */
export function sanitizeStringContent(text) {
  if (typeof text !== 'string') return text

  return text
    // Redact postgres/mysql/redis URLs with credentials
    .replace(/(postgresql|postgres|mysql|redis):\/\/[^@/]+@/gi, '$1://[redacted]@')
    // Redact Windows absolute filesystem paths (e.g. C:\Users\... or D:\E\...)
    .replace(/[A-Za-z]:\\(?:[^ :,\r\n\t"']+\\)+[^ :,\r\n\t"']*/g, '[internal path]')
    // Redact Unix server paths (e.g. /home/... or /var/www/...)
    .replace(/\/(?:home|root|var|etc|usr)\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]*/g, '[internal path]')
}

/**
 * Recursively sanitizes any data payload (object, array, primitive).
 * Removes all keys matching sensitive fields and sanitizes string contents.
 *
 * @param {any} data - Input payload
 * @param {object} [options]
 * @param {Set<string>} [options.extraForbiddenFields] - Additional keys to prune
 * @returns {any} Sanitized payload
 */
export function sanitizeResponseDto(data, options = {}) {
  if (data === null || data === undefined) return data

  // Handle primitives
  if (typeof data === 'string') {
    return sanitizeStringContent(data)
  }
  if (typeof data !== 'object') {
    return data
  }

  // Handle Date, Buffer, RegExp instances
  if (data instanceof Date || Buffer.isBuffer(data) || data instanceof RegExp) {
    return data
  }

  // Handle Arrays
  if (Array.isArray(data)) {
    return data.map((item) => sanitizeResponseDto(item, options))
  }

  // Handle plain Objects
  const customForbidden = options.extraForbiddenFields || null
  const sanitized = {}

  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveKey(key)) {
      continue
    }
    if (customForbidden && (customForbidden.has(key) || customForbidden.has(key.toLowerCase()))) {
      continue
    }

    sanitized[key] = sanitizeResponseDto(value, options)
  }

  return sanitized
}

/**
 * Strictly sanitizes a User database row or object into a public User DTO.
 * Guarantees zero sensitive fields (no password hash, refresh tokens, OTP counters).
 *
 * @param {object} user - Raw user entity
 * @returns {object|null} Whitelisted User DTO
 */
export function sanitizeUserDto(user) {
  if (!user || typeof user !== 'object') return null

  return {
    id: user.id,
    email: user.email,
    role: user.role || 'user',
    name: user.name || '',
    email_verified: Boolean(user.email_verified || user.emailVerified),
    avatar: user.avatar || null,
    created_date: user.created_date || user.createdAt || null,
  }
}

/**
 * Strictly sanitizes an API Key entity into a safe public DTO.
 * Never exposes the raw or encrypted API key secret.
 *
 * @param {object} key - Raw API key entity
 * @returns {object|null} Whitelisted API Key DTO
 */
export function sanitizeApiKeyDto(key) {
  if (!key || typeof key !== 'object') return null

  return {
    id: key.id,
    user_id: key.user_id || key.userId,
    provider: key.provider,
    label: key.label || key.name || '',
    key_prefix: key.key_prefix || key.keyPrefix || (key.preview ? key.preview : null),
    preview: key.preview || key.key_prefix || null,
    tier: key.tier || 'standard',
    priority: key.priority ?? 0,
    is_active: key.is_active !== undefined ? Boolean(key.is_active) : (key.isActive !== undefined ? Boolean(key.isActive) : true),
    created_date: key.created_date || key.createdAt || null,
    last_used_date: key.last_used_date || key.lastUsedAt || null,
  }
}

/**
 * Express middleware that intercepts res.json() to guarantee all outgoing
 * HTTP JSON responses are stripped of sensitive fields and server paths.
 */
export function responseSanitizerMiddleware(_req, res, next) {
  const originalJson = res.json.bind(res)

  res.json = function(data) {
    const sanitized = sanitizeResponseDto(data)
    return originalJson(sanitized)
  }

  next()
}
