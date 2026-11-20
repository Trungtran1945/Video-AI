import bcrypt from 'bcryptjs'

/**
 * Precomputed 10-round bcrypt hash for constant-time comparison when user doesn't exist
 * (SEC-03 mitigation: prevents timing-based user enumeration).
 */
export const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export const MIN_PASSWORD_CHARS = 8
export const MAX_PASSWORD_BYTES = 72
export const DEFAULT_BCRYPT_ROUNDS = 10

/**
 * Validates password complexity & safety bounds:
 * - Minimum 8 characters
 * - Maximum 72 bytes (BCrypt truncation boundary to prevent silent truncation & CPU DoS)
 * - Disallows empty or whitespace-only strings
 *
 * @param {string} password
 * @returns {{ valid: boolean, message?: string }}
 */
export function validatePasswordPolicy(password) {
  if (typeof password !== 'string') {
    return { valid: false, message: 'Mật khẩu phải là chuỗi ký tự.' }
  }
  if (!password.trim()) {
    return { valid: false, message: 'Mật khẩu không được để trống hoặc chỉ chứa khoảng trắng.' }
  }
  if (password.length < MIN_PASSWORD_CHARS) {
    return { valid: false, message: `Mật khẩu phải có tối thiểu ${MIN_PASSWORD_CHARS} ký tự.` }
  }
  const byteLen = Buffer.byteLength(password, 'utf8')
  if (byteLen > MAX_PASSWORD_BYTES) {
    return { valid: false, message: `Mật khẩu không được vượt quá ${MAX_PASSWORD_BYTES} bytes (${byteLen} bytes nhận được).` }
  }
  return { valid: true }
}

/**
 * Asserts password policy, throwing if invalid.
 */
export function assertPasswordPolicy(password) {
  const result = validatePasswordPolicy(password)
  if (!result.valid) {
    const err = new Error(result.message)
    err.code = 'INVALID_PASSWORD'
    err.statusCode = 400
    throw err
  }
  return true
}

/**
 * Hashes a password using BCrypt with per-password salt and configured rounds (default 10).
 * Enforces policy before hashing.
 *
 * @param {string} password
 * @param {number} [rounds=10]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, rounds = DEFAULT_BCRYPT_ROUNDS) {
  assertPasswordPolicy(password)
  return bcrypt.hash(password, rounds)
}

/**
 * Safely compares password against hash.
 * If password exceeds 72 bytes, compares against dummy to prevent CPU exhaustion.
 *
 * @param {string} password
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function comparePassword(password, hash) {
  if (typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    // Prevent BCrypt CPU DoS on excessively long inputs
    await bcrypt.compare('', DUMMY_BCRYPT_HASH)
    return false
  }
  return bcrypt.compare(password, hash || DUMMY_BCRYPT_HASH)
}

/**
 * Extracts the cost factor (rounds) from a standard bcrypt hash string.
 * Example: '$2a$10$...' -> 10, '$2b$08$...' -> 8
 *
 * @param {string} hash
 * @returns {number} rounds or 0 if invalid
 */
export function getBcryptRounds(hash) {
  if (typeof hash !== 'string') return 0
  const match = hash.match(/^\$2[aby]\$(\d+)\$/)
  return match ? parseInt(match[1], 10) : 0
}

/**
 * Checks whether an existing hash needs rehashing (e.g. was created with rounds < targetRounds).
 *
 * @param {string} hash
 * @param {number} [targetRounds=10]
 * @returns {boolean}
 */
export function needsRehash(hash, targetRounds = DEFAULT_BCRYPT_ROUNDS) {
  const currentRounds = getBcryptRounds(hash)
  return currentRounds > 0 && currentRounds < targetRounds
}

export default {
  DUMMY_BCRYPT_HASH,
  MIN_PASSWORD_CHARS,
  MAX_PASSWORD_BYTES,
  DEFAULT_BCRYPT_ROUNDS,
  validatePasswordPolicy,
  assertPasswordPolicy,
  hashPassword,
  comparePassword,
  getBcryptRounds,
  needsRehash,
}
