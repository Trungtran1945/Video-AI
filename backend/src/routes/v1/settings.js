import { Router } from 'express'
import { queryOne, run } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'

const router = Router()
router.use(authMiddleware)

// settings PK is user_id (no id column) — always SELECT/UPDATE by user_id.
const ALLOWED = [
  'default_language',
  'default_style',
  'default_duration',
  'max_retries',
  'auto_upload_youtube',
  'notify_on_complete',
  'active_llm_provider',
  'active_image_provider',
  'active_video_provider',
  'active_voice_provider',
  'active_subtitle_provider',
  'voice_provider',
  'aspect_ratio',
]
// Booleans/ints stored as INTEGER in SQLite
const INT_FIELDS = new Set(['default_duration', 'max_retries', 'auto_upload_youtube', 'notify_on_complete'])

async function getOrCreateSettings(userId) {
  let s = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userId])
  if (!s) {
    // INSERT OR IGNORE avoids the rowid-race of the generic insert() helper;
    // two concurrent GETs then both re-SELECT the single canonical row.
    await run('INSERT OR IGNORE INTO settings (user_id) VALUES (?)', [userId])
    s = await queryOne('SELECT * FROM settings WHERE user_id = ?', [userId])
  }
  return s
}

function normalize(patch) {
  const out = {}
  for (const f of ALLOWED) {
    if (patch[f] === undefined) continue
    if (INT_FIELDS.has(f)) out[f] = patch[f] === true ? 1 : patch[f] === false || patch[f] === null ? 0 : Number(patch[f]) || 0
    else out[f] = String(patch[f])
  }
  return out
}

// GET /api/v1/settings
router.get('/', async (req, res) => {
  try {
    res.json(await getOrCreateSettings(req.user.id))
  } catch (err) {
    console.error('Get settings error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

// PUT /api/v1/settings
router.put('/', async (req, res) => {
  try {
    await getOrCreateSettings(req.user.id)
    const patch = normalize(req.body || {})
    const cols = Object.keys(patch)
    if (!cols.length) return res.json(await getOrCreateSettings(req.user.id))
    const sql = `UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ?`
    await run(sql, [...cols.map((c) => patch[c]), req.user.id])
    res.json(await getOrCreateSettings(req.user.id))
  } catch (err) {
    console.error('Update settings error:', err)
    res.status(500).json({ message: 'Internal server error', code: 'INTERNAL_ERROR' })
  }
})

export default router
