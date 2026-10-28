import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'
import { prepareScriptText, SCRIPT_LIMITS, ScriptValidationError } from '../../services/scriptService.js'
import { createScriptUpload } from '../../services/scriptUploadService.js'

const router = Router()
router.use(authMiddleware)

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md'])
const ALLOWED_MIMES = new Set(['text/plain', 'text/markdown', 'application/octet-stream', ''])
const MAX_BYTES = SCRIPT_LIMITS.maxBytes

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 4 },
})

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'script.txt')).replace(/[\u0000-\u001f\\/]/g, '').trim()
  return (base || 'script.txt').slice(0, 255)
}

function uploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next()
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 413, 'SCRIPT_TOO_LARGE', `File kịch bản vượt quá ${MAX_BYTES} byte (2MB)`)
    }
    if (err?.code === 'LIMIT_UNEXPECTED_FILE' || err?.code === 'LIMIT_FILE_COUNT') {
      return sendError(res, 400, 'SCRIPT_UPLOAD_INVALID', 'Chỉ gửi một file ở field "file"', { field: 'file' })
    }
    return sendError(res, 400, 'SCRIPT_UPLOAD_INVALID', 'Upload không hợp lệ', { field: 'file' })
  })
}

// POST /api/v1/script-uploads (multipart field "file")
router.post('/', uploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, 'SCRIPT_UPLOAD_INVALID', 'Thiếu file kịch bản (field "file")', { field: 'file' })
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase()
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return sendError(res, 415, 'SCRIPT_FORMAT_UNSUPPORTED', 'Chỉ hỗ trợ .txt hoặc .md — hãy convert DOCX/PDF sang TXT/MD', { field: 'file' })
    }
    const mime = String(req.file.mimetype || '').toLowerCase()
    if (!ALLOWED_MIMES.has(mime)) {
      return sendError(res, 415, 'SCRIPT_FORMAT_UNSUPPORTED', 'Định dạng MIME không được hỗ trợ cho kịch bản', { field: 'file' })
    }
    const prepared = prepareScriptText(req.file.buffer)
    const filename = sanitizeFilename(req.file.originalname)
    const row = await createScriptUpload({
      userId: req.user.id,
      filename,
      mime: mime || null,
      text: prepared.text,
      sha256: prepared.sha256,
      byteSize: req.file.size,
      charCount: prepared.charCount,
    })
    res.status(201).json({
      id: row.id,
      filename: row.filename,
      byteSize: row.byte_size,
      charCount: row.char_count,
      sha256: row.sha256,
      preview: prepared.text.slice(0, 500),
      createdAt: row.created_date,
    })
  } catch (err) {
    if (err instanceof ScriptValidationError) {
      return sendError(res, err.statusCode, err.code, err.message, err.extra)
    }
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs })
    }
    console.error('Script upload error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
