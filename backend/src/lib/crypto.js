import crypto from 'node:crypto'
import { isPlaceholderSecret, MIN_SECRET_LENGTH } from '../config.js'

// AES-256-GCM authenticated encryption for sensitive data (API keys, OAuth tokens)
const ALGO = 'aes-256-gcm'
const IV_LENGTH = 12 // 12 bytes recommended for AES-GCM
const AUTH_TAG_LENGTH = 16 // 16 bytes authentication tag

/**
 * Validates master key strength in production or strict mode.
 */
export function assertMasterKey({
  nodeEnv = process.env.NODE_ENV,
  strictSecrets = (process.env.STRICT_SECRETS === 'true'),
  masterKey = process.env.MASTER_KEY,
} = {}) {
  const isStrict = nodeEnv === 'production' || strictSecrets === true || strictSecrets === 'true'
  if (!isStrict) return
  if (!masterKey || isPlaceholderSecret(masterKey) || String(masterKey).length < MIN_SECRET_LENGTH) {
    throw new Error(
      `[Crypto] FATAL: missing or unsafe MASTER_KEY in production/strict mode. Set MASTER_KEY (>=${MIN_SECRET_LENGTH} chars).`
    )
  }
}

/**
 * Returns candidate master keys in priority order:
 * 1. Primary key (process.env.MASTER_KEY or override)
 * 2. Previous master keys for rotation (process.env.PREVIOUS_MASTER_KEYS)
 *
 * @param {string|string[]} [overrideKey]
 * @returns {string[]}
 */
export function getMasterKeys(overrideKey) {
  if (overrideKey) {
    if (Array.isArray(overrideKey)) return overrideKey.filter(Boolean)
    return [String(overrideKey)]
  }
  const primary = process.env.MASTER_KEY || 'dev'
  const prevStr = process.env.PREVIOUS_MASTER_KEYS || ''
  const prevList = prevStr
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  return [primary, ...prevList]
}

function deriveKey(secret) {
  // Derive a 32-byte key from secret using SHA-256 (never logged)
  return crypto.createHash('sha256').update(String(secret)).digest()
}

/**
 * Encrypts plaintext using AES-256-GCM with a 12-byte random IV.
 * Produces versioned output: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 *
 * @param {string} plainText
 * @param {string|string[]} [masterKeyOverride]
 * @returns {string|null}
 */
export function encrypt(plainText, masterKeyOverride) {
  if (plainText == null) return null
  const keys = getMasterKeys(masterKeyOverride)
  const primaryKey = keys[0]
  assertMasterKey({ masterKey: primaryKey })

  const key = deriveKey(primaryKey)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

/**
 * Decrypts AES-256-GCM ciphertext payload.
 * Supports:
 * - Versioned format: `v1:<iv_hex>:<tag_hex>:<ciphertext_hex>`
 * - Legacy unversioned format: `<iv_hex>:<tag_hex>:<ciphertext_hex>`
 * - Key rotation: tries primary key first, then fallback to PREVIOUS_MASTER_KEYS.
 * - Integrity failure: throws Error if payload is tampered, corrupted, or has invalid auth tag.
 *
 * @param {string} payload
 * @param {string|string[]} [masterKeyOverride]
 * @returns {string|null}
 */
export function decrypt(payload, masterKeyOverride) {
  if (payload == null || payload === '') return null
  if (typeof payload !== 'string') {
    throw new TypeError('Invalid payload: expected string')
  }

  const parts = payload.split(':')
  let ivHex, tagHex, dataHex

  if (parts[0] === 'v1' && parts.length === 4) {
    [, ivHex, tagHex, dataHex] = parts
  } else if (parts.length === 3) {
    // Legacy unversioned format
    [ivHex, tagHex, dataHex] = parts
  } else {
    throw new Error('Invalid ciphertext format: unrecognized payload structure')
  }

  const hexPattern = /^[0-9a-fA-F]*$/
  if (!hexPattern.test(ivHex) || !hexPattern.test(tagHex) || !hexPattern.test(dataHex)) {
    throw new Error('Invalid ciphertext format: non-hex characters detected')
  }

  const ivBuf = Buffer.from(ivHex, 'hex')
  const tagBuf = Buffer.from(tagHex, 'hex')
  const dataBuf = Buffer.from(dataHex, 'hex')

  if (ivBuf.length !== IV_LENGTH || tagBuf.length !== AUTH_TAG_LENGTH) {
    throw new Error(`Invalid ciphertext format: unexpected IV (${ivBuf.length}) or auth tag (${tagBuf.length}) length`)
  }

  const candidateKeys = getMasterKeys(masterKeyOverride)
  let lastError = null

  for (const candidate of candidateKeys) {
    try {
      const keyBuf = deriveKey(candidate)
      const decipher = crypto.createDecipheriv(ALGO, keyBuf, ivBuf)
      decipher.setAuthTag(tagBuf)
      const dec = Buffer.concat([decipher.update(dataBuf), decipher.final()])
      return dec.toString('utf8')
    } catch (err) {
      lastError = err
    }
  }

  throw new Error(`Decryption failed: authentication tag verification failed or key mismatch (${lastError?.message || 'AEAD integrity error'})`)
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export default { encrypt, decrypt, sha256, assertMasterKey, getMasterKeys }
