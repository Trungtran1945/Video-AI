import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { query, queryOne, run } from '../../db/query.js'
import { resolveStorageKey } from '../../pipeline/context.js'
import composerService from '../../services/composerService.js'

const router = Router()
router.use(authMiddleware)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 50 }, // 100MB per file, up to 50 files
})

function uploadHandler(req, res, next) {
  upload.fields([{ name: 'files', maxCount: 50 }, { name: 'file', maxCount: 1 }])(req, res, (err) => {
    if (!err) return next()
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'FILE_TOO_LARGE', 'Tệp tải lên vượt quá giới hạn 100MB')
    }
    return sendError(res, 400, 'UPLOAD_ERROR', err.message || 'Lỗi tải lên tệp')
  })
}

// GET /api/v1/projects/:id/assets
router.get('/:id/assets', requireProjectOwner, async (req, res) => {
  try {
    const assets = await query(
      'SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC, created_date ASC',
      [req.project.id]
    )
    const formatted = assets.map((a) => ({
      id: a.id,
      projectId: a.project_id,
      userId: a.user_id,
      kind: a.kind,
      name: a.name,
      storageKey: a.storage_key,
      url: `/storage/${a.storage_key}`,
      thumbnailKey: a.thumbnail_key,
      thumbnailUrl: a.thumbnail_key ? `/storage/${a.thumbnail_key}` : (a.mime_type?.startsWith('image/') ? `/storage/${a.storage_key}` : null),
      durationSec: a.duration_sec,
      byteSize: a.byte_size,
      mimeType: a.mime_type,
      ocrText: a.ocr_text,
      ocrData: a.ocr_data ? JSON.parse(a.ocr_data) : null,
      translationText: a.translation_text,
      translationTargetLang: a.translation_target_lang,
      orderIndex: a.order_index,
      createdDate: a.created_date,
    }))
    res.json({ assets: formatted })
  } catch (err) {
    console.error('Get assets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/projects/:id/assets
router.post('/:id/assets', requireProjectOwner, uploadHandler, async (req, res) => {
  try {
    const files = req.files?.files || (req.files?.file ? [req.files.file[0]] : [])
    if (!files || files.length === 0) {
      return sendError(res, 400, ERR.VALIDATION, 'Cần ít nhất một file để tải lên', { field: 'files' })
    }

    const kind = req.body?.kind || 'image'
    const startIndex = Number(req.body?.orderIndex) || 0

    const savedAssets = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const saved = await composerService.saveUploadedAsset({
        projectId: req.project.id,
        userId: req.user.id,
        file,
        kind,
        orderIndex: startIndex + i,
      })
      savedAssets.push(saved)
    }

    res.status(200).json({ assets: savedAssets })
  } catch (err) {
    console.error('Upload assets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Lỗi lưu trữ tệp')
  }
})

// DELETE /api/v1/projects/:id/assets/:assetId
router.delete('/:id/assets/:assetId', requireProjectOwner, async (req, res) => {
  try {
    const asset = await queryOne('SELECT * FROM assets WHERE id = ? AND project_id = ?', [req.params.assetId, req.project.id])
    if (!asset) return sendError(res, 404, ERR.VALIDATION, 'Không tìm thấy asset', { field: 'assetId' })

    const absPath = resolveStorageKey(asset.storage_key)
    if (absPath && fs.existsSync(absPath)) {
      try { fs.unlinkSync(absPath) } catch (_) {}
    }
    if (asset.thumbnail_key) {
      const thumbAbs = resolveStorageKey(asset.thumbnail_key)
      if (thumbAbs && fs.existsSync(thumbAbs)) {
        try { fs.unlinkSync(thumbAbs) } catch (_) {}
      }
    }

    await run('DELETE FROM assets WHERE id = ?', [req.params.assetId])
    await run('DELETE FROM audios WHERE id = ?', [req.params.assetId])
    await run('DELETE FROM timeline_clips WHERE asset_id = ? OR voice_audio_id = ?', [req.params.assetId, req.params.assetId])

    res.json({ message: 'Deleted', assetId: req.params.assetId })
  } catch (err) {
    console.error('Delete asset error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// PUT /api/v1/projects/:id/assets/reorder
router.put('/:id/assets/reorder', requireProjectOwner, async (req, res) => {
  try {
    const assetIds = req.body?.assetIds
    if (!Array.isArray(assetIds)) {
      return sendError(res, 400, ERR.VALIDATION, 'Danh sách assetIds không hợp lệ', { field: 'assetIds' })
    }

    for (let i = 0; i < assetIds.length; i++) {
      await run('UPDATE assets SET order_index = ? WHERE id = ? AND project_id = ?', [i, assetIds[i], req.project.id])
    }

    const updated = await query('SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC, created_date ASC', [req.project.id])
    res.json({ assets: updated })
  } catch (err) {
    console.error('Reorder assets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/projects/:id/assets/:assetId/ocr
router.post('/:id/assets/:assetId/ocr', requireProjectOwner, async (req, res) => {
  try {
    const result = await composerService.processOcr({
      assetId: req.params.assetId,
      projectId: req.project.id,
      userId: req.user.id,
    })
    res.json(result)
  } catch (err) {
    console.error('OCR error:', err)
    sendError(res, 500, 'OCR_FAILED', err.message || 'Không thể nhận diện chữ từ hình ảnh')
  }
})

// POST /api/v1/projects/:id/assets/:assetId/translate
router.post('/:id/assets/:assetId/translate', requireProjectOwner, async (req, res) => {
  try {
    const text = req.body?.text
    if (!text || !text.trim()) {
      return sendError(res, 400, ERR.VALIDATION, 'Văn bản dịch không được để trống', { field: 'text' })
    }
    const targetLanguage = req.body?.targetLanguage || 'vi'
    const sourceLanguage = req.body?.sourceLanguage || 'auto'

    const result = await composerService.processTranslation({
      text,
      targetLanguage,
      sourceLanguage,
      assetId: req.params.assetId,
      userId: req.user.id,
    })
    res.json(result)
  } catch (err) {
    console.error('Translate error:', err)
    sendError(res, 500, 'TRANSLATE_FAILED', err.message || 'Lỗi dịch thuật văn bản')
  }
})

// POST /api/v1/projects/:id/tts
router.post('/:id/tts', requireProjectOwner, async (req, res) => {
  try {
    const text = req.body?.text
    if (!text || !text.trim()) {
      return sendError(res, 400, ERR.VALIDATION, 'Văn bản chuyển giọng nói không được để trống', { field: 'text' })
    }
    const voiceProvider = req.body?.voiceProvider || 'edge_tts'
    const voiceId = req.body?.voiceId || null

    const result = await composerService.generateVoiceoverTts({
      projectId: req.project.id,
      userId: req.user.id,
      text,
      voiceProvider,
      voiceId,
    })
    res.json(result)
  } catch (err) {
    console.error('TTS error:', err)
    sendError(res, 500, 'TTS_FAILED', err.message || 'Không thể tổng hợp giọng đọc AI')
  }
})

// POST /api/v1/projects/:id/auto-arrange
router.post('/:id/auto-arrange', requireProjectOwner, async (req, res) => {
  try {
    const options = {
      imageDurationSec: Number(req.body?.imageDurationSec) || 4,
      loopBgm: req.body?.loopBgm !== false,
      enableDucking: req.body?.enableDucking !== false,
      bgmVolume: Number(req.body?.bgmVolume) || 0.3,
      defaultBackground: req.body?.defaultBackground || '#0F1117',
    }
    const result = await composerService.autoArrangeTimeline({
      projectId: req.project.id,
      options,
    })
    res.json(result)
  } catch (err) {
    console.error('Auto arrange error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Lỗi tự động sắp xếp timeline')
  }
})

// PUT /api/v1/projects/:id/timeline
router.put('/:id/timeline', requireProjectOwner, async (req, res) => {
  try {
    const tracks = req.body?.tracks || []
    const clips = req.body?.clips || []
    const result = await composerService.saveTimeline({
      projectId: req.project.id,
      tracks,
      clips,
    })
    res.json(result)
  } catch (err) {
    console.error('Save timeline error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Lỗi lưu trạng thái timeline')
  }
})

export default router
