// Security Hardening TASK-05: Data Encryption & Master Key Rotation Test Suite
// Run: node backend/tests/securityTask05Encryption.test.mjs
import crypto from 'node:crypto'
import {
  encrypt,
  decrypt,
  sha256,
  assertMasterKey,
  getMasterKeys,
} from '../src/lib/crypto.js'

let failures = 0
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg)
  } else {
    failures++
    console.error('FAIL:', msg)
  }
}

console.log('=== TASK 5: Data Encryption & Key Rotation (AES-256-GCM) Test Suite ===\n')

const testSecret = 'sk-super-secret-user-api-key-123456789'
const primaryKey = 'primary-master-key-32-chars-long-abc!'
const oldKey1 = 'old-master-key-first-generation-123!'
const oldKey2 = 'old-master-key-second-generation-456!'

// 1. Versioned AES-256-GCM Encryption / Decryption
console.log('--- 1. Versioned AES-256-GCM Encryption & Decryption ---')
{
  const ciphertext = encrypt(testSecret, primaryKey)
  assert(ciphertext.startsWith('v1:'), `ciphertext contains version prefix (got ${ciphertext.slice(0, 3)})`)

  const parts = ciphertext.split(':')
  assert(parts.length === 4, `ciphertext has exactly 4 parts v1:iv:tag:data (got ${parts.length})`)
  assert(parts[1].length === 24, `IV is 12 bytes / 24 hex characters (got ${parts[1].length})`)
  assert(parts[2].length === 32, `Auth Tag is 16 bytes / 32 hex characters (got ${parts[2].length})`)

  const decrypted = decrypt(ciphertext, primaryKey)
  assert(decrypted === testSecret, `decrypted text matches original plaintext (got ${decrypted})`)

  // Null & empty handling
  assert(encrypt(null) === null, 'encrypt(null) returns null')
  assert(decrypt(null) === null, 'decrypt(null) returns null')
  assert(decrypt('') === null, 'decrypt("") returns null')
}

// 2. Tamper Resistance & AEAD Integrity Verification
console.log('\n--- 2. AEAD Integrity Verification & Tamper Resistance ---')
{
  const ciphertext = encrypt(testSecret, primaryKey)
  const parts = ciphertext.split(':')

  // 2.1 Tampered Ciphertext Data
  const tamperedData = parts[3].slice(0, -2) + (parts[3].endsWith('aa') ? 'bb' : 'aa')
  const tamperedCiphertext = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedData}`
  let threwOnData = false
  try {
    decrypt(tamperedCiphertext, primaryKey)
  } catch (err) {
    threwOnData = true
  }
  assert(threwOnData, 'tampered ciphertext data causes decrypt() to fail with integrity error')

  // 2.2 Tampered Authentication Tag
  const tamperedTag = (parts[2].endsWith('00') ? 'ff' : '00') + parts[2].slice(2)
  const tamperedTagCiphertext = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`
  let threwOnTag = false
  try {
    decrypt(tamperedTagCiphertext, primaryKey)
  } catch (err) {
    threwOnTag = true
  }
  assert(threwOnTag, 'tampered auth tag causes decrypt() to fail with integrity error')

  // 2.3 Invalid Format / Non-Hex Characters
  let threwOnNonHex = false
  try {
    decrypt(`v1:${parts[1]}:${parts[2]}:not_hex_data!`, primaryKey)
  } catch (err) {
    threwOnNonHex = true
  }
  assert(threwOnNonHex, 'non-hex payload rejected with format error')

  // 2.4 Corrupted structure (e.g. random string)
  let threwOnCorrupt = false
  try {
    decrypt('corrupted_random_payload_without_colons', primaryKey)
  } catch (err) {
    threwOnCorrupt = true
  }
  assert(threwOnCorrupt, 'unstructured payload rejected with format error')
}

// 3. Backward Compatibility with Legacy Payloads
console.log('\n--- 3. Backward Compatibility with Legacy Payloads ---')
{
  // Construct legacy unversioned payload: iv:tag:data (without 'v1:' prefix)
  const rawKey = crypto.createHash('sha256').update(primaryKey).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', rawKey, iv)
  const enc = Buffer.concat([cipher.update('legacy-secret-format', 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const legacyPayload = `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`

  assert(!legacyPayload.startsWith('v1:'), 'legacy payload has no v1 prefix')
  const decryptedLegacy = decrypt(legacyPayload, primaryKey)
  assert(decryptedLegacy === 'legacy-secret-format', `legacy payload decrypted successfully (got ${decryptedLegacy})`)
}

// 4. Master Key Rotation Support
console.log('\n--- 4. Master Key Rotation Support ---')
{
  // Encrypt with old key 1
  const ciphertextOld1 = encrypt('secret-encrypted-with-old-key-1', oldKey1)
  // Encrypt with old key 2
  const ciphertextOld2 = encrypt('secret-encrypted-with-old-key-2', oldKey2)

  // Decrypt using primary key only -> should fail
  let failPrimaryOnly = false
  try {
    decrypt(ciphertextOld1, primaryKey)
  } catch (err) {
    failPrimaryOnly = true
  }
  assert(failPrimaryOnly, 'decrypting with wrong primary key alone fails')

  // Decrypt with key rotation list: [primaryKey, oldKey1, oldKey2]
  const rotationKeys = [primaryKey, oldKey1, oldKey2]
  const decryptedOld1 = decrypt(ciphertextOld1, rotationKeys)
  assert(decryptedOld1 === 'secret-encrypted-with-old-key-1', 'fallback to oldKey1 succeeds under key rotation')

  const decryptedOld2 = decrypt(ciphertextOld2, rotationKeys)
  assert(decryptedOld2 === 'secret-encrypted-with-old-key-2', 'fallback to oldKey2 succeeds under key rotation')

  // Verification via process.env.PREVIOUS_MASTER_KEYS
  const originalPrimary = process.env.MASTER_KEY
  const originalPrevious = process.env.PREVIOUS_MASTER_KEYS
  try {
    process.env.MASTER_KEY = primaryKey
    process.env.PREVIOUS_MASTER_KEYS = `${oldKey1}, ${oldKey2}`

    assert(getMasterKeys().length === 3, 'getMasterKeys() reads primary and PREVIOUS_MASTER_KEYS list')
    const envDecrypted = decrypt(ciphertextOld1)
    assert(envDecrypted === 'secret-encrypted-with-old-key-1', 'decrypt() without override uses environment key rotation')
  } finally {
    process.env.MASTER_KEY = originalPrimary
    process.env.PREVIOUS_MASTER_KEYS = originalPrevious
  }
}

// 5. Master Key Validation & Production Fail-Fast
console.log('\n--- 5. Master Key Validation & Production Fail-Fast ---')
{
  // 5.1 Safe master key passes
  let threwSafe = false
  try {
    assertMasterKey({
      nodeEnv: 'production',
      strictSecrets: true,
      masterKey: 'very-strong-and-sufficiently-long-production-key-32chars',
    })
  } catch (_) {
    threwSafe = true
  }
  assert(!threwSafe, 'strong master key passes validation in production')

  // 5.2 Short master key fails
  let threwShort = false
  try {
    assertMasterKey({
      nodeEnv: 'production',
      strictSecrets: true,
      masterKey: 'too-short',
    })
  } catch (err) {
    threwShort = true
  }
  assert(threwShort, 'short master key fails in production')

  // 5.3 Placeholder master key fails
  let threwPlaceholder = false
  try {
    assertMasterKey({
      nodeEnv: 'production',
      strictSecrets: true,
      masterKey: 'dev-master-key',
    })
  } catch (err) {
    threwPlaceholder = true
  }
  assert(threwPlaceholder, 'placeholder master key (dev-master-key) fails in production')

  // 5.4 Missing master key fails in production
  let threwMissing = false
  try {
    assertMasterKey({
      nodeEnv: 'production',
      strictSecrets: true,
      masterKey: '',
    })
  } catch (err) {
    threwMissing = true
  }
  assert(threwMissing, 'missing master key fails in production')

  // 5.5 In dev mode without strictSecrets, weak key is allowed
  let threwDev = false
  try {
    assertMasterKey({
      nodeEnv: 'development',
      strictSecrets: false,
      masterKey: 'dev',
    })
  } catch (_) {
    threwDev = true
  }
  assert(!threwDev, 'weak master key is tolerated in development mode without strict secrets')
}

// 6. SHA-256 helper
console.log('\n--- 6. SHA-256 Utility Function ---')
{
  const hash1 = sha256('hello world')
  const hash2 = sha256('hello world')
  const hash3 = sha256('different string')
  assert(hash1 === hash2, 'sha256 is deterministic')
  assert(hash1 !== hash3, 'different inputs yield different sha256 hashes')
  assert(hash1.length === 64, 'sha256 returns 64 hex characters')
}

console.log(failures === 0 ? '\nALL TASK 5 TESTS PASS' : `\n${failures} FAILURES IN TASK 5`)
process.exit(failures === 0 ? 0 : 1)
