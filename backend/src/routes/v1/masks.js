import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { query, queryOne, run, insert } from '../../db/query.js'
import { authMiddleware } from '../../middleware/auth.js'
import { requireProjectOwner } from '../../middleware/projectAccess.js'
import { sendError, ERR } from '../../lib/httpError.js'
import { deriveAutoRegions } from '../../pipeline/stages/dubRender.js'

const router = Router()
router.use(authMiddleware)

const isDubMode = (mode) => {
  const m = String(mode || '').toUpperCase().replace('-', '_')
  return m === 'TRANSLATE_DUB'
}

const MASK_TYPES = ['blur', 'solid']

// Mask approve lifecycle (§2): DRAFT (đang chỉnh, render bỏ qua) → APPROVED
// (render bắt buộc dùng) | DISABLED (giữ row, render bỏ qua).
// `status` là source of truth duy nhất; `enabled` chỉ giữ tương thích cũ và luôn
// mirror theo status (APPROVED→1, DISABLED→0, DRAFT giữ nguyên). Mọi mutation đi
// qua normalizeMaskState nên không tồn tại APPROVED+0 hay DISABLED+1.
const MASK_STATUSES = ['DRAFT', 'APPROVED', 'DISABLED']

// Normalize về một state hợp lệ duy nhất (decision 3a).
// - APPROVED → enabled=1 (kể cả khi client gửi enabled:0 tường minh)
// - DISABLED → enabled=0 (kể cả khi client gửi enabled:1 tường minh)
// - DRAFT → giữ enabled tường minh, fallback row/request hiện tại
// - enabled-only patch (không kèm status): APPROVED+0 → DISABLED+0,
//   DISABLED+1 → APPROVED+1, DRAFT giữ DRAFT.
export function normalizeMaskState({ status, enabled }, row = null) {
  const hasStatus = status !== undefined
  const hasEnabled = enabled !== undefined
  // enabled-only patch (không kèm status): diễn giải như bật/tắt trên status hiện tại.
  if (!hasStatus && hasEnabled && row) {
    const cur = String(row.status || 'DRAFT').toUpperCase()
    if (cur === 'APPROVED' && enabled === 0) return { status: 'DISABLED', enabled: 0 }
    if (cur === 'DISABLED' && enabled === 1) return { status: 'APPROVED', enabled: 1 }
    if (cur === 'APPROVED') return { status: 'APPROVED', enabled: 1 }
    if (cur === 'DISABLED') return { status: 'DISABLED', enabled: 0 }
    return { status: 'DRAFT', enabled }
  }
  const baseStatus = hasStatus ? status : row?.status || 'DRAFT'
  if (baseStatus === 'APPROVED') return { status: 'APPROVED', enabled: 1 }
  if (baseStatus === 'DISABLED') return { status: 'DISABLED', enabled: 0 }
  // DRAFT (hoặc thiếu): không render nên enabled nào cũng hợp lệ, ưu tiên explicit.
  if (hasEnabled) return { status: 'DRAFT', enabled }
  if (hasStatus) return { status: 'DRAFT', enabled: row?.enabled ?? 1 }
  return { status: baseStatus, enabled: hasEnabled ? enabled : (row?.enabled ?? 1) }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Validate input mask. Full mode (POST) yêu cầu đủ toạ độ + timing;
// partial mode (PATCH) chỉ validate field được gửi. Không throw — trả về
// {ok, value} hoặc {ok:false, field, message} để route map thành 400.
export function validateMaskInput(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {}
  const out = {}
  const fail = (field, message) => ({ ok: false, field, message })

  const need = (name) => !partial || b[name] !== undefined

  const ratio = (name, { min = 0, max = 1, allowZero = true } = {}) => {
    if (!need(name)) return null
    const n = num(b[name])
    if (n === null) return fail(name, `${name} phải là số`)
    if (n < min || n > max || (!allowZero && n <= 0)) return fail(name, `${name} không hợp lệ`)
    out[name] = n
    return null
  }

  let e
  if ((e = ratio('ratioX'))) return e
  if ((e = ratio('ratioY'))) return e
  if ((e = ratio('ratioW', { allowZero: false }))) return e
  if ((e = ratio('ratioH', { allowZero: false }))) return e
  if (need('startSec')) {
    const n = num(b.startSec)
    if (n === null || n < 0) return fail('startSec', 'startSec phải >= 0')
    out.startSec = n
  }
  if (need('endSec')) {
    const n = num(b.endSec)
    if (n === null) return fail('endSec', 'endSec phải là số')
    out.endSec = n
  }
  if (out.startSec !== undefined && out.endSec !== undefined && !(out.endSec > out.startSec)) {
    return fail('endSec', 'endSec phải > startSec')
  }
  if (need('type')) {
    const t = String(b.type ?? 'blur')
    if (!MASK_TYPES.includes(t)) return fail('type', `type phải là ${MASK_TYPES.join('|')}`)
    out.type = t
  }
  if (need('blurRadius')) {
    const n = b.blurRadius === undefined && partial ? undefined : num(b.blurRadius ?? 8)
    if (partial && b.blurRadius === undefined) {
      // không gửi thì thôi
    } else {
      if (n === null || n < 1 || n > 50) return fail('blurRadius', 'blurRadius phải trong 1..50')
      out.blurRadius = n
    }
  }
  if (need('opacity')) {
    const n = b.opacity === undefined && partial ? undefined : num(b.opacity ?? 1)
    if (partial && b.opacity === undefined) {
      // không gửi thì thôi
    } else {
      if (n === null || n < 0 || n > 1) return fail('opacity', 'opacity phải trong 0..1')
      out.opacity = n
    }
  }
  if (b.enabled !== undefined) {
    out.enabled = b.enabled === true || b.enabled === 1 || b.enabled === '1' ? 1 : 0
  }
  if (b.status !== undefined) {
    const s = String(b.status || '').toUpperCase()
    if (!MASK_STATUSES.includes(s)) return fail('status', `status phải là ${MASK_STATUSES.join('|')}`)
    out.status = s
  }
  if (b.text !== undefined) {
    out.text = typeof b.text === 'string' ? b.text.slice(0, 500) : null
  }
  if (!partial) {
    out.type = out.type || 'blur'
    if (out.blurRadius === undefined) out.blurRadius = 8
    if (out.opacity === undefined) out.opacity = 1
    if (out.status === undefined) out.status = 'DRAFT'
    // Normalize về state hợp lệ duy nhất (status SoT).
    const norm = normalizeMaskState({ status: out.status, enabled: out.enabled })
    out.status = norm.status
    out.enabled = norm.enabled
  }
  return { ok: true, value: out }
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

// Dựng mask AUTO suy ra từ transcript OCR — single source of truth nằm ở
// deriveAutoRegions (dubRender.js), route chỉ map sang JSON API.
export async function deriveAutoMasks(projectId, maskMethod) {
  const regions = await deriveAutoRegions(projectId, maskMethod)
  return regions.map(toMaskJson)
}

export function toMaskJson(r) {
  const source = r.source || 'MANUAL'
  return {
    ...r,
    startSec: r.start_sec ?? r.startSec,
    endSec: r.end_sec ?? r.endSec,
    ratioX: r.ratio_x ?? r.ratioX,
    ratioY: r.ratio_y ?? r.ratioY,
    ratioW: r.ratio_w ?? r.ratioW,
    ratioH: r.ratio_h ?? r.ratioH,
    blurRadius: r.blur_radius ?? r.blurRadius ?? 8,
    opacity: r.opacity ?? 1,
    enabled: r.enabled === 1 || r.enabled === true,
    source,
    type: r.type || 'blur',
    // Mask ảo AUTO suy ra lúc đọc (deriveAutoRegions) luôn coi như APPROVED
    // để filter render đồng nhất; mask MANUAL thiếu status → DRAFT.
    status: r.status || (source === 'AUTO' ? 'APPROVED' : 'DRAFT'),
  }
}

// GET /api/v1/projects/:id/masks — manual đã lưu + automatic suy ra từ transcript.
router.get('/projects/:id/masks', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có mask', { field: 'mode' })
    }
    const stored = await query(
      'SELECT * FROM ocr_regions WHERE project_id = ? ORDER BY start_sec ASC',
      [req.project.id]
    )
    const params = parseParams(req.project.params)
    const auto = await deriveAutoMasks(req.project.id, params.maskMethod)
    res.json({ masks: [...stored.map(toMaskJson), ...auto] })
  } catch (err) {
    console.error('Masks GET error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

// POST /api/v1/projects/:id/masks — tạo manual mask.
router.post('/projects/:id/masks', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có mask', { field: 'mode' })
    }
    const v = validateMaskInput(req.body || {})
    if (!v.ok) return sendError(res, 400, ERR.VALIDATION, v.message, { field: v.field })
    const row = await insert('ocr_regions', {
      id: uuidv4(),
      project_id: req.project.id,
      start_sec: v.value.startSec,
      end_sec: v.value.endSec,
      ratio_x: v.value.ratioX,
      ratio_y: v.value.ratioY,
      ratio_w: v.value.ratioW,
      ratio_h: v.value.ratioH,
      type: v.value.type,
      blur_radius: v.value.blurRadius,
      opacity: v.value.opacity,
      enabled: v.value.enabled,
      status: v.value.status,
      text: v.value.text ?? null,
      confidence: null,
      source: 'MANUAL',
    })
    res.status(201).json(toMaskJson(row))
  } catch (err) {
    console.error('Masks POST error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

async function loadOwnedMask(projectId, maskId) {
  if (String(maskId || '').startsWith('auto:')) return { auto: true, row: null }
  const row = await queryOne('SELECT * FROM ocr_regions WHERE id = ? AND project_id = ?', [maskId, projectId])
  return { auto: false, row }
}

// PATCH /api/v1/projects/:id/masks/:maskId — sửa manual mask (AUTO chỉ đọc).
router.patch('/projects/:id/masks/:maskId', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có mask', { field: 'mode' })
    }
    const { row, auto } = await loadOwnedMask(req.project.id, req.params.maskId)
    if (auto || (row && String(row.source || '').toUpperCase() === 'AUTO')) {
      return sendError(res, 400, ERR.VALIDATION, 'Mask tự động chỉ đọc — hãy tạo mask thủ công mới để override', { field: 'maskId' })
    }
    if (!row) return sendError(res, 404, ERR.VALIDATION, 'Mask không tồn tại trong project này', { field: 'maskId' })
    const v = validateMaskInput(req.body || {}, { partial: true })
    if (!v.ok) return sendError(res, 400, ERR.VALIDATION, v.message, { field: v.field })
    const patch = {}
    if (v.value.ratioX !== undefined) patch.ratio_x = v.value.ratioX
    if (v.value.ratioY !== undefined) patch.ratio_y = v.value.ratioY
    if (v.value.ratioW !== undefined) patch.ratio_w = v.value.ratioW
    if (v.value.ratioH !== undefined) patch.ratio_h = v.value.ratioH
    if (v.value.startSec !== undefined) patch.start_sec = v.value.startSec
    if (v.value.endSec !== undefined) patch.end_sec = v.value.endSec
    if (v.value.type !== undefined) patch.type = v.value.type
    if (v.value.blurRadius !== undefined) patch.blur_radius = v.value.blurRadius
    if (v.value.opacity !== undefined) patch.opacity = v.value.opacity
    if (v.value.status !== undefined || v.value.enabled !== undefined) {
      // status là SoT: normalize mọi tổ hợp status/enabled về state hợp lệ duy nhất.
      const norm = normalizeMaskState({ status: v.value.status, enabled: v.value.enabled }, row)
      patch.status = norm.status
      patch.enabled = norm.enabled
    }
    if (v.value.text !== undefined) patch.text = v.value.text
    // Validate timing sau merge (end > start).
    const startSec = patch.start_sec !== undefined ? patch.start_sec : row.start_sec
    const endSec = patch.end_sec !== undefined ? patch.end_sec : row.end_sec
    if (!(Number(endSec) > Number(startSec)) || Number(startSec) < 0) {
      return sendError(res, 400, ERR.VALIDATION, 'Timing mask không hợp lệ (0<=start<end)', { field: 'endSec' })
    }
    if (Object.keys(patch).length) {
      const sets = Object.keys(patch).map((c) => `${c} = ?`).join(', ')
      await run(`UPDATE ocr_regions SET ${sets} WHERE id = ?`, [...Object.values(patch), row.id])
    }
    const updated = await queryOne('SELECT * FROM ocr_regions WHERE id = ?', [row.id])
    res.json(toMaskJson(updated))
  } catch (err) {
    console.error('Masks PATCH error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

// DELETE /api/v1/projects/:id/masks/:maskId — xoá manual mask.
router.delete('/projects/:id/masks/:maskId', requireProjectOwner, async (req, res) => {
  try {
    if (!isDubMode(req.project.mode)) {
      return sendError(res, 400, ERR.VALIDATION, 'Chỉ dự án TRANSLATE_DUB mới có mask', { field: 'mode' })
    }
    const { row, auto } = await loadOwnedMask(req.project.id, req.params.maskId)
    if (auto || (row && String(row.source || '').toUpperCase() === 'AUTO')) {
      return sendError(res, 400, ERR.VALIDATION, 'Mask tự động chỉ đọc — không thể xoá', { field: 'maskId' })
    }
    if (!row) return sendError(res, 404, ERR.VALIDATION, 'Mask không tồn tại trong project này', { field: 'maskId' })
    await run('DELETE FROM ocr_regions WHERE id = ?', [row.id])
    res.json({ deleted: true, id: row.id })
  } catch (err) {
    console.error('Masks DELETE error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', err.message || 'Internal server error')
  }
})

export default router
