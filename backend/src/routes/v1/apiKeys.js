import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, insert, run } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { encrypt, decrypt } from '../../lib/crypto.js'

const router = Router()
router.use(authMiddleware)

function mask(key) {
  if (!key) return ''
  const s = String(key)
  if (s.length <= 8) return '****'
  return s.slice(0, 4) + '****' + s.slice(-4)
}

// GET /api/v1/api-keys
router.get('/', async (req, res) => {
  const rows = await query('SELECT id, user_id, provider, label, is_active, created_date, encrypted_key FROM api_keys WHERE user_id = ? ORDER BY created_date DESC', [req.user.id])
  res.json(rows.map((r) => ({ ...r, keyPreview: mask(decrypt(r.encrypted_key)), encrypted_key: undefined })))
})

// POST /api/v1/api-keys
router.post('/', async (req, res) => {
  const { provider, label, key } = req.body || {}
  if (!provider || !key) return res.status(400).json({ message: 'provider and key are required', code: 'VALIDATION_ERROR' })
  const row = await insert('api_keys', {
    id: uuidv4(),
    user_id: req.user.id,
    provider,
    label: label || provider,
    encrypted_key: encrypt(key),
    is_active: 1,
  })
  res.json({ id: row.id, provider: row.provider, label: row.label, is_active: row.is_active, keyPreview: mask(key) })
})

// DELETE /api/v1/api-keys/:id
router.delete('/:id', async (req, res) => {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  if (!row) return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' })
  await run('DELETE FROM api_keys WHERE id = ?', [req.params.id])
  res.json({ message: 'Deleted' })
})

// PUT /api/v1/api-keys/:id  (toggle active / update label)
router.put('/:id', async (req, res) => {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  if (!row) return res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' })
  const patch = {}
  if (typeof req.body?.isActive === 'boolean') patch.is_active = req.body.isActive ? 1 : 0
  if (typeof req.body?.label === 'string') patch.label = req.body.label
  if (Object.keys(patch).length) await run('UPDATE api_keys SET is_active = ?, label = ? WHERE id = ?', [patch.is_active ?? row.is_active, patch.label ?? row.label, req.params.id])
  const updated = await queryOne('SELECT id, provider, label, is_active FROM api_keys WHERE id = ?', [req.params.id])
  res.json(updated)
})

export default router
