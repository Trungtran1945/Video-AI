import { Router } from 'express'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { confirmPreviewUseCase } from '../../usecases/confirmPreviewUseCase.js'
import { sendError } from '../../lib/httpError.js'

const router = Router()

// POST /api/v1/projects/:id/translate-dub/confirm-preview — FR-J2
router.post('/:id/translate-dub/confirm-preview', requireProjectOwner, async (req, res) => {
  try {
    const result = await confirmPreviewUseCase(req.params.id, req.body.regions)
    res.status(202).json(result)
  } catch (err) {
    console.error('Confirm preview error:', err)
    const status = err.code === 'VALIDATION' ? 400 : 500
    sendError(res, status, err.code || 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

export default router
