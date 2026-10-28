import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, run, runReturningOne } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { encrypt, decrypt } from '../../lib/crypto.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

function mask(key) {
  if (!key) return ''
  const s = String(key)
  // Narrow preview: first 2 + last 2 only (was 4+4) — Eye-toggle label states
  // this is a masked preview, never the full key.
  if (s.length <= 8) return '****'
  return s.slice(0, 2) + '****' + s.slice(-2)
}

function safePreview(encryptedKey) {
  try {
    return mask(decrypt(encryptedKey))
  } catch (_) {
    return null
  }
}

// Allowlist registry (mirrors providers/registry.js ids) — reject unknown
// provider sớm 400, không insert rồi fail ở stage xa (PROV_001).
const KNOWN_PROVIDERS = new Set([
  'gemini', 'openai', 'anthropic', 'huggingface', 'whisper', 'openai_whisper',
  'faster_whisper', 'elevenlabs', 'openai_tts', 'zerotts', 'edge_tts',
  'google_tts', 'azure_speech', 'clip', 'google_translate', 'mock',
])

// GET /api/v1/api-keys
router.get('/', async (req, res) => {
  const rows = await query('SELECT id, user_id, provider, label, is_active, tier, priority, created_date, encrypted_key FROM api_keys WHERE user_id = ? ORDER BY created_date DESC', [req.user.id])
  // Row hỏng decrypt → { error:'DECRYPT_FAILED', keyPreview:null }, không 500 cả list.
  res.json(rows.map((r) => {
    const preview = safePreview(r.encrypted_key)
    return {
      ...r,
      keyPreview: preview,
      ...(preview === null ? { error: 'DECRYPT_FAILED' } : {}),
      encrypted_key: undefined,
    }
  }))
})

// POST /api/v1/api-keys
router.post('/', async (req, res) => {
  const { provider, label, key, tier, priority } = req.body || {}
  if (!provider || !key) return sendError(res, 400, ERR.VALIDATION, 'provider and key are required', { field: 'provider,key' })
  if (!KNOWN_PROVIDERS.has(String(provider))) {
    return sendError(res, 400, 'INVALID_PROVIDER', `Unknown provider '${provider}'`, { field: 'provider' })
  }
  const row = await insert('api_keys', {
    id: uuidv4(),
    user_id: req.user.id,
    provider,
    label: label || provider,
    encrypted_key: encrypt(key),
    is_active: 1,
    tier: tier || 'free',
    priority: priority || 0,
  })
  res.json({ id: row.id, provider: row.provider, label: row.label, tier: row.tier, priority: row.priority, is_active: row.is_active, keyPreview: mask(key) })
})

// DELETE /api/v1/api-keys/:id
router.delete('/:id', async (req, res) => {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  if (!row) return sendError(res, 404, 'NOT_FOUND', 'Not found')
  await run('DELETE FROM api_keys WHERE id = ?', [req.params.id])
  res.json({ message: 'Deleted' })
})

// PUT /api/v1/api-keys/:id  (toggle active / update label/tier/priority)
router.put('/:id', async (req, res) => {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  if (!row) return sendError(res, 404, 'NOT_FOUND', 'Not found')
  const patch = {}
  if (typeof req.body?.isActive === 'boolean') patch.is_active = req.body.isActive ? 1 : 0
  if (typeof req.body?.label === 'string') patch.label = req.body.label
  if (typeof req.body?.tier === 'string') patch.tier = req.body.tier
  if (typeof req.body?.priority === 'number') patch.priority = req.body.priority
  // Mutation + response read as one atomic unit: no post-commit SELECT can
  // report failure for an UPDATE already persisted to disk.
  const updated = await runReturningOne(
    'UPDATE api_keys SET is_active = ?, label = ?, tier = ?, priority = ? WHERE id = ?',
    [patch.is_active ?? row.is_active, patch.label ?? row.label, patch.tier ?? row.tier, patch.priority ?? row.priority, req.params.id],
    'SELECT id, provider, label, is_active, tier, priority FROM api_keys WHERE id = ?',
    [req.params.id],
    { op: 'update.api_keys' }
  )
  res.json(updated)
})

export default router
