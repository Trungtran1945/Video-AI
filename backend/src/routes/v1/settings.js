import { Router } from 'express'
import { queryOne, runReturningOne } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { sendError } from '../../lib/httpError.js'

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
    // two concurrent GETs then both land on the single canonical row. The
    // result row is read in the same write-lock slot BEFORE persisting, so a
    // rejection here can never mean "inserted but reported failed".
    s = await runReturningOne(
      'INSERT OR IGNORE INTO settings (user_id) VALUES (?)',
      [userId],
      'SELECT * FROM settings WHERE user_id = ?',
      [userId],
      { op: 'insert.settings' }
    )
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
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
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
    // Response row read in the same write-lock slot BEFORE persisting.
    let s = await runReturningOne(
      sql,
      [...cols.map((c) => patch[c]), req.user.id],
      'SELECT * FROM settings WHERE user_id = ?',
      [req.user.id],
      { op: 'update.settings' }
    )
    if (!s) s = await getOrCreateSettings(req.user.id)
    res.json(s)
  } catch (err) {
    console.error('Update settings error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})

export default router
