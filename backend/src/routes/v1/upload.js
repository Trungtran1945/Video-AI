import { Router } from 'express'
import multer from 'multer'
import express from 'express'
import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../../config.js'
import { authMiddleware } from '../../middleware/auth.js'
import { queryOne, insert, updateById } from '../../db/query.js'
import { sendError, ERR } from '../../lib/httpError.js'

const router = Router()
router.use(authMiddleware)

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.storageDir, 'uploads')
    fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ''
    cb(null, `${uuidv4()}${ext}`)
  },
})
const upload = multer({ storage, limits: { fileSize: 4 * 1024 * 1024 * 1024 } }) // 4GB

// POST /api/v1/upload  (single file — legacy multipart, dùng cho tệp nhỏ)
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return sendError(res, 400, ERR.VALIDATION, 'No file uploaded', { field: 'file' })
  const rel = `uploads/${req.file.filename}`
  res.json({
    key: rel,
    url: `/storage/${rel}`,
    filename: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  })
})

// ── Resumable upload kiểu TUS (docs/06 §2.1) — video lớn ≤ 2GB ────────────
const CHUNK_SIZE = 8 * 1024 * 1024 // 8MB
const MAX_SIZE = 2 * 1024 * 1024 * 1024

function sessionDir(sessionId) {
  const dir = path.join(config.storageDir, 'tmp', 'upload_sessions', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sessionTmpPath(session) {
  return session.tmp_path || path.join(sessionDir(session.id), 'blob.bin')
}

// POST /api/v1/uploads/init {filename,size,mime} → {uploadId, chunkSize}
router.post('/init', async (req, res) => {
  try {
    const b = req.body || {}
    if (!b.filename) return sendError(res, 400, ERR.VALIDATION, 'filename is required', { field: 'filename' })
    const size = Number(b.size) || 0
    if (size > MAX_SIZE) return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'File vượt quá giới hạn 2GB')

    const session = await insert('upload_sessions', {
      id: uuidv4(),
      user_id: req.user.id,
      filename: String(b.filename).slice(0, 255),
      size,
      mime: b.mime ? String(b.mime).slice(0, 100) : null,
      tmp_path: null,
      bytes_received: 0,
      status: 'pending',
    })
    sessionDir(session.id) // tạo thư mục trước
    res.status(201).json({ uploadId: session.id, chunkSize: CHUNK_SIZE })
  } catch (err) {
    console.error('Upload init error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// HEAD /api/v1/uploads/:id → header upload-offset (client resume sau rớt mạng)
router.head('/:id', async (req, res) => {
  const session = await queryOne('SELECT * FROM upload_sessions WHERE id = ?', [req.params.id])
  if (!session || session.user_id !== req.user.id) return sendError(res, 404, 'NOT_FOUND', 'Session not found')
  res.set('Upload-Offset', String(session.bytes_received || 0))
  res.set('Cache-Control', 'no-store')
  res.status(200).end()
})

// PUT /api/v1/uploads/:id/chunk?offset=N (application/octet-stream, idempotent theo offset)
const rawBody = express.raw({ type: 'application/octet-stream', limit: '16mb' })
router.put('/:id/chunk', rawBody, async (req, res) => {
  try {
    const session = await queryOne('SELECT * FROM upload_sessions WHERE id = ?', [req.params.id])
    if (!session || session.user_id !== req.user.id) return sendError(res, 404, 'NOT_FOUND', 'Session not found')
    if (session.status === 'completed') return sendError(res, 409, 'UPLOAD_COMPLETED', 'Upload đã hoàn tất')

    const offset = Number(req.query.offset)
    if (!Number.isInteger(offset) || offset < 0) {
      return sendError(res, 400, ERR.VALIDATION, 'offset query param is required', { field: 'offset' })
    }
    if (offset !== Number(session.bytes_received)) {
      // Idempotency: offset lệch → báo client biết phải resume từ đâu (docs/07 §2.1)
      return sendError(res, 409, 'OFFSET_MISMATCH', `Offset mismatch: server có ${session.bytes_received}, client gửi ${offset}`, {
        expectedOffset: session.bytes_received,
      })
    }

    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || [])
    if (!chunk.length) return sendError(res, 400, ERR.VALIDATION, 'Empty chunk')

    const tmpPath = sessionTmpPath(session)
    await fs.promises.appendFile(tmpPath, chunk)

    const received = offset + chunk.length
    await updateById('upload_sessions', session.id, { bytes_received: received, tmp_path: tmpPath })
    res.set('Upload-Offset', String(received))
    res.status(204).end()
  } catch (err) {
    console.error('Upload chunk error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

// POST /api/v1/uploads/:id/complete → ghép xong, move vào storage/uploads/<uuid>.<ext>
router.post('/:id/complete', async (req, res) => {
  try {
    let session = await queryOne('SELECT * FROM upload_sessions WHERE id = ?', [req.params.id])
    if (!session || session.user_id !== req.user.id) return sendError(res, 404, 'NOT_FOUND', 'Session not found')

    if (session.status === 'completed' && session.storage_key) {
      return res.json({ storageKey: session.storage_key, url: `/storage/${session.storage_key}`, filename: session.filename, size: session.size })
    }

    const tmpPath = sessionTmpPath(session)
    if (!fs.existsSync(tmpPath)) return sendError(res, 409, 'NO_DATA', 'Chưa có chunk nào được tải lên')
    if (session.size && session.bytes_received !== session.size) {
      return sendError(res, 409, 'INCOMPLETE_UPLOAD', `Chưa đủ dữ liệu: ${session.bytes_received}/${session.size} bytes`, {
        expectedOffset: session.bytes_received,
      })
    }

    const ext = path.extname(session.filename || '') || '.bin'
    const finalName = `${uuidv4()}${ext}`
    const finalAbs = path.join(config.storageDir, 'uploads', finalName)
    await fs.promises.rename(tmpPath, finalAbs)

    const rel = `uploads/${finalName}`
    session = await updateById('upload_sessions', session.id, {
      status: 'completed',
      storage_key: rel,
      size: session.bytes_received,
    })

    res.json({
      storageKey: rel,
      url: `/storage/${rel}`,
      filename: session.filename,
      size: session.bytes_received,
    })
  } catch (err) {
    console.error('Upload complete error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
