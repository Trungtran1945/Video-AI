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

const router = Router()

router.use('/auth', authRouter)
router.use('/projects', projectsRouter)
router.use('/projects', generationRouter)
router.use('/upload', uploadRouter)
router.use('/outputs', outputsRouter)
router.use('/queue', queueRouter)
router.use('/analytics', analyticsRouter)
router.use('/providers', providersRouter)
router.use('/settings', settingsRouter)
router.use('/api-keys', apiKeysRouter)
router.use('/logs', logsRouter)
router.use('/admin', adminRouter)

export default router
