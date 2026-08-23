import crypto from 'node:crypto'

// AES-256-GCM encryption for user API keys (master key from env)
const ALGO = 'aes-256-gcm'

function getKey() {
  // Derive a 32-byte key from MASTER_KEY
  return crypto.createHash('sha256').update(process.env.MASTER_KEY || 'dev').digest()
}

export function encrypt(plainText) {
  if (plainText == null) return null
  const key = getKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

export function decrypt(payload) {
  if (!payload) return null
  const [ivHex, tagHex, dataHex] = payload.split(':')
  if (!ivHex || !tagHex || !dataHex) return payload
  const key = getKey()
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()])
  return dec.toString('utf8')
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex')
}

export default { encrypt, decrypt, sha256 }
