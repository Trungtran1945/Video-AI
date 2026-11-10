import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { query, queryOne, run, withTransaction } from '../../db/query.js'
import { resolveStorageKey, ensureDir } from '../../pipeline/context.js'
import { config } from '../../config.js'
import composerService from '../../services/composerService.js'

const router = Router()
router.use(authMiddleware)

const tmpUploadsDir = ensureDir(path.join(config.storageDir, 'tmp_uploads'))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tmpUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase()
    cb(null, `${uuidv4()}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024, files: 50 }, // 100MB per file, up to 50 files
})

function totalSizeLimit(req, res, next) {
  const len = Number(req.headers['content-length'] || 0)
  if (len > 200 * 1024 * 1024) {
    return sendError(res, 413, 'BATCH_TOO_LARGE', 'Tổng dung lượng tệp tải lên vượt quá giới hạn 200MB')
  }
  next()
}

function uploadHandler(req, res, next) {
  upload.fields([{ name: 'files', maxCount: 50 }, { name: 'file', maxCount: 1 }])(req, res, (err) => {
    if (!err) return next()
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'FILE_TOO_LARGE', 'Tệp tải lên vượt quá giới hạn 100MB')
    }
    return sendError(res, 400, 'UPLOAD_ERROR', err.message || 'Lỗi tải lên tệp')
  })
}

function checkMediaSignature(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false
  let fd
  try {
    fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(16)
    const bytesRead = fs.readSync(fd, buf, 0, 16, 0)
    if (bytesRead < 4) return false

    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
    // RIFF (WEBP / WAV / AVI)
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      if (bytesRead >= 12) {
        const typeStr = buf.toString('ascii', 8, 12)
        if (typeStr === 'WEBP' || typeStr === 'WAVE' || typeStr === 'AVI ') return true
      }
      return true
    }
    // MP3: ID3 or sync frame FF FB / FF F3 / FF F2 / FF E0
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true
    // MP4 / QuickTime (MOV, M4A, MP4): ftyp or moov at offset 4
    if (bytesRead >= 8 && (buf.toString('ascii', 4, 8) === 'ftyp' || buf.toString('ascii', 4, 8) === 'moov')) return true
    // OGG: OggS
    if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true
    // EBML (WebM / MKV): 1A 45 DF A3
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true

    return false
  } catch (_) {
    return false
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch (_) {}
    }
  }
}

// Format an asset row / object into standardized dual-compatibility ComposerAssetDTO
export function formatAsset(a) {
  if (!a) return null
  const storageKey = a.storage_key || a.storageKey || null
  const thumbnailKey = a.thumbnail_key || a.thumbnailKey || null
  const mimeType = a.mime_type || a.mimeType || null
  const isImg = mimeType?.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(storageKey || '')

  return {
    id: a.id,
    projectId: a.project_id || a.projectId,
    project_id: a.project_id || a.projectId,
    userId: a.user_id ?? a.userId ?? null,
    user_id: a.user_id ?? a.userId ?? null,
    kind: a.kind,
    name: a.name || 'Untitled',
    storageKey,
    storage_key: storageKey,
    url: storageKey ? `/storage/${storageKey}` : null,
    thumbnailKey: thumbnailKey || null,
    thumbnail_key: thumbnailKey || null,
    thumbnailUrl: thumbnailKey
      ? `/storage/${thumbnailKey}`
      : (isImg && storageKey ? `/storage/${storageKey}` : null),
    durationSec: a.duration_sec != null ? Number(a.duration_sec) : (a.durationSec != null ? Number(a.durationSec) : null),
    duration_sec: a.duration_sec != null ? Number(a.duration_sec) : (a.durationSec != null ? Number(a.durationSec) : null),
    byteSize: a.byte_size != null ? Number(a.byte_size) : (a.byteSize != null ? Number(a.byteSize) : null),
    byte_size: a.byte_size != null ? Number(a.byte_size) : (a.byteSize != null ? Number(a.byteSize) : null),
    mimeType: mimeType || null,
    mime_type: mimeType || null,
    ocrText: a.ocr_text || a.ocrText || null,
    ocr_text: a.ocr_text || a.ocrText || null,
    ocrData: a.ocr_data ? (typeof a.ocr_data === 'string' ? JSON.parse(a.ocr_data) : a.ocr_data) : (a.ocrData || null),
    ocr_data: typeof a.ocr_data === 'string' ? a.ocr_data : (a.ocrData ? JSON.stringify(a.ocrData) : null),
    translationText: a.translation_text || a.translationText || null,
    translation_text: a.translation_text || a.translationText || null,
    translationTargetLang: a.translation_target_lang || a.translationTargetLang || null,
    translation_target_lang: a.translation_target_lang || a.translationTargetLang || null,
    orderIndex: Number(a.order_index ?? a.orderIndex ?? 0),
    order_index: Number(a.order_index ?? a.orderIndex ?? 0),
    createdDate: a.created_date || a.createdDate || null,
    created_date: a.created_date || a.createdDate || null,
  }
}

// GET /api/v1/projects/:id/assets
router.get('/:id/assets', requireProjectOwner, async (req, res) => {
  try {
    let assets = []
    try {
      assets = await query(
        'SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC, created_date ASC',
        [req.project.id]
      )
    } catch (queryErr) {
      console.warn(`[composerAssets] Query assets with created_date failed, fallback:`, queryErr?.message || queryErr)
      assets = await query(
        'SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC',
        [req.project.id]
      )
    }
    res.json({ assets: assets.map(formatAsset) })
  } catch (err) {
    console.error('Get assets error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/projects/:id/assets
router.post('/:id/assets', requireProjectOwner, totalSizeLimit, uploadHandler, async (req, res) => {
  const files = req.files?.files || (req.files?.file ? [req.files.file[0]] : [])
  const cleanupFiles = () => {
    for (const f of files) {
      if (f.path && fs.existsSync(f.path)) {
        try { fs.unlinkSync(f.path) } catch (_) {}
      }
    }
  }

  try {
    if (!files || files.length === 0) {
      return sendError(res, 400, ERR.VALIDATION, 'Cần ít nhất một file để tải lên', { field: 'files' })
    }

    // Validate MIME types and Magic Bytes
    for (const file of files) {
      const isValidSig = checkMediaSignature(file.path)
      if (!isValidSig) {
        cleanupFiles()
        return sendError(
          res,
          400,
          'UNSUPPORTED_MEDIA_TYPE',
          `Tệp "${file.originalname}" không phải định dạng media hợp lệ hoặc chứa nội dung không an toàn`
        )
      }
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

    res.status(200).json({ assets: savedAssets.map(formatAsset) })
  } catch (err) {
    cleanupFiles()
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

    await withTransaction(async (tx) => {
      await tx.run('DELETE FROM timeline_clips WHERE (asset_id = ? OR voice_audio_id = ?) AND project_id = ?', [req.params.assetId, req.params.assetId, req.project.id])
      await tx.run('DELETE FROM audios WHERE id = ? AND project_id = ?', [req.params.assetId, req.project.id])
      await tx.run('DELETE FROM assets WHERE id = ? AND project_id = ?', [req.params.assetId, req.project.id])
    })

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

    let updated = []
    try {
      updated = await query('SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC, created_date ASC', [req.project.id])
    } catch (queryErr) {
      console.warn(`[composerAssets] Reorder query assets with created_date failed, fallback:`, queryErr?.message || queryErr)
      updated = await query('SELECT * FROM assets WHERE project_id = ? ORDER BY order_index ASC', [req.project.id])
    }
    res.json({ assets: updated.map(formatAsset) })
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
    sendError(res, err.statusCode || 500, err.code || 'OCR_FAILED', err.message || 'Không thể nhận diện chữ từ hình ảnh')
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
    sendError(res, err.statusCode || 500, err.code || 'TRANSLATE_FAILED', err.message || 'Lỗi dịch thuật văn bản')
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
    const status = err.statusCode || (err.code === 'INVALID_TIMELINE_DATA' ? 400 : 500)
    sendError(res, status, err.code || 'INTERNAL_ERROR', err.message || 'Lỗi lưu trạng thái timeline')
  }
})

export default router
