import { Router } from 'express'
import authRouter from './auth.js'
import projectsRouter from './projects.js'
import generationRouter from './generation.js'
import uploadRouter from './upload.js'
import outputsRouter from './outputs.js'
import queueRouter from './queue.js'
import analyticsRouter from './analytics.js'
import providersRouter from './providers.js'
import settingsRouter from './settings.js'
import apiKeysRouter from './apiKeys.js'
import logsRouter from './logs.js'
import adminRouter from './admin.js'
import dubDataRouter from './dubData.js'
import masksRouter from './masks.js'
import eventsRouter from './events.js'
import confirmPreviewRouter from './confirmPreview.js'
import scriptUploadsRouter from './scriptUploads.js'
import youtubeRouter from './youtube.js'

const router = Router()

router.use('/auth', authRouter)
router.use('/projects', projectsRouter)
router.use('/projects', generationRouter)
router.use('/projects', confirmPreviewRouter) // FR-J2: POST /projects/:id/translate-dub/confirm-preview
router.use('/script-uploads', scriptUploadsRouter)
router.use('/youtube', youtubeRouter)
router.use('/', dubDataRouter) // /style-presets + /projects/:id/transcript
router.use('/', masksRouter) // /projects/:id/masks (manual mask CRUD + auto derive)
router.use('/', eventsRouter) // SSE GET /projects/:id/events
// Một router phục vụ cả 2 protocol dưới cả 2 prefix (backward-compat, có test
// uploadHttpContract khóa lại): canonical là POST /upload (multipart ≤50MB) và
// POST /uploads/init → PUT /uploads/:id/chunk → POST /uploads/:id/complete →
// DELETE /uploads/:id (resumable TUS, limit 2GB). Không tách router để tránh vỡ
// contract hiện tại của FE + tests.
router.use('/upload', uploadRouter) // legacy multipart (canonical) + TUS alias
router.use('/uploads', uploadRouter) // resumable kiểu TUS (docs/06 §2.1, canonical)
router.use('/outputs', outputsRouter)
router.use('/queue', queueRouter)
router.use('/analytics', analyticsRouter)
router.use('/providers', providersRouter)
router.use('/settings', settingsRouter)
router.use('/api-keys', apiKeysRouter)
router.use('/logs', logsRouter)
router.use('/admin', adminRouter)

export default router
