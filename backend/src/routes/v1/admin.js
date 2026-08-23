import { Router } from 'express'
import { query, queryOne, updateById } from '../../db/query.js'
import { authMiddleware, requireRole } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware, requireRole('admin'))

// GET /api/v1/admin/users
router.get('/users', async (req, res) => {
  const users = await query('SELECT id, email, role, name, credits, created_date FROM users ORDER BY created_date DESC')
  res.json(users)
})

// PUT /api/v1/admin/users/:id  (change role)
router.put('/users/:id', async (req, res) => {
  const { role } = req.body || {}
  if (!['user', 'admin', 'guest'].includes(role)) return res.status(400).json({ message: 'Invalid role', code: 'VALIDATION_ERROR' })
  const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.params.id])
  if (!user) return res.status(404).json({ message: 'User not found', code: 'NOT_FOUND' })
  const updated = await updateById('users', user.id, { role })
  res.json({ id: updated.id, email: updated.email, role: updated.role })
})

// GET /api/v1/admin/providers
router.get('/providers', async (req, res) => {
  res.json({
    global: true,
    note: 'Provider keys are supplied per-user via /api-keys in this build.',
  })
})

export default router
