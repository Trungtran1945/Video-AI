import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { config } from '../../config.js'
import { authMiddleware } from '../../middleware/auth.js'

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

// POST /api/v1/upload  (single file)
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded', code: 'VALIDATION_ERROR' })
  const rel = `uploads/${req.file.filename}`
  res.json({
    key: rel,
    url: `/storage/${rel}`,
    filename: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  })
})

export default router
