import { Worker } from 'bullmq'
import fs from 'node:fs'
import path from 'path'
import { connection } from '../connection.js'
import { query, run } from '../../db/query.js'
import { projectDir, resolveStorageKey } from '../../pipeline/context.js'
import { config } from '../../config.js'

/**
 * CleanupWorker — Cron repeatable job: cleanup.sweep
 * Quét projects.expiresAt < now() AND status IN ('success', 'failed')
 * Xóa file trong storage/tmp/{projectId}, giữ lại Output.
 * Projects CANCELLED: dọn ngay lập tức (trong cancelProjectUseCase).
 */
const worker = new Worker('cleanup', async (job) => {
  const retentionDays = config.projectRetentionDays
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffISO = cutoffDate.toISOString()

  let cleaned = 0

  // Find expired projects with intermediate files
  const expiredProjects = await query(
    `SELECT id, status, user_id FROM projects WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('success', 'failed')`,
    [cutoffISO]
  )

  for (const project of expiredProjects) {
    const dir = projectDir(project.id)

    // Clean up intermediate files (keep outputs)
    try {
      if (fs.existsSync(dir)) {
        // Remove tmp directory contents
        const tmpDir = path.join(dir, 'tmp')
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true })
        }
        // Remove frames directory (OCR)
        const framesDir = path.join(dir, 'frames')
        if (fs.existsSync(framesDir)) {
          fs.rmSync(framesDir, { recursive: true, force: true })
        }
        // Remove thumbs directory
        const thumbsDir = path.join(dir, 'thumbs')
        if (fs.existsSync(thumbsDir)) {
          fs.rmSync(thumbsDir, { recursive: true, force: true })
        }
        // Remove intermediate audio files but keep final outputs
        const audioDir = path.join(dir, 'audios')
        if (fs.existsSync(audioDir)) {
          fs.rmSync(audioDir, { recursive: true, force: true })
        }
      }
    } catch (err) {
      console.error(`[Cleanup] Error cleaning project ${project.id}:`, err.message)
    }

    // Clear expires_at to indicate cleanup is done
    await run(
      `UPDATE projects SET expires_at = NULL WHERE id = ?`,
      [project.id]
    )
    cleaned++
  }

  // Also clean up storage/tmp directory for very old files
  const tmpRoot = path.join(config.storageDir, 'tmp')
  try {
    if (fs.existsSync(tmpRoot)) {
      const entries = fs.readdirSync(tmpRoot, { withFileTypes: true })
      const now = Date.now()
      const maxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(tmpRoot, entry.name)
          try {
            const stat = fs.statSync(dirPath)
            if (now - stat.mtimeMs > maxAge) {
              fs.rmSync(dirPath, { recursive: true, force: true })
              cleaned++
            }
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning tmp directory:', err.message)
  }

  return { cleaned }
}, {
  connection,
  concurrency: 1,
  limiter: { max: 1, duration: 300000 }, // Max 1 job per 5 minutes
})

worker.on('failed', (job, err) => {
  console.error('[Cleanup] Job failed:', err.message)
})

worker.on('completed', (job, result) => {
  if (result.cleaned > 0) {
    console.log(`[Cleanup] Cleaned ${result.cleaned} expired project(s)`)
  }
})

export default worker
