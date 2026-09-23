// Deterministic transcript timing model (TRANSLATE_DUB).
// Invariant (minimal-push, decision 1a):
// - start_sec >= 0, end_sec > start_sec
// - segments sorted by index_num keep order, no overlap: next.start >= prev.end + GAP
// - GAP = 0.1 applied consistently
// - no negative values, no exceeding video duration when durationSec is known
// - same input batch always produces same output (sorted by index_num, not payload order)
// Semantics: only push downstream when needed to resolve overlap, by exactly
// `need = prevEnd + GAP - nextStart` (cumulative). Explicit timing in the same
// batch wins; if auto-push requirement contradicts an explicit timing, the whole
// batch is a conflict (caller rejects, writes nothing).

export const TIMING_GAP = 0.1
const EPS = 1e-9

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Pure text/translation resolution (mirrors PUT semantics):
// - text changed without translation key → translation=null + flag reset (stale, re-translate)
// - translation key present → flag = 1 when non-null string
export function applyTextTranslation(orig, patch = {}) {
  const hasTextKey = patch.text !== undefined
  const hasTranslationKey = patch.translation !== undefined
  const newText = typeof patch.text === 'string' ? patch.text : orig.text
  const textChanged = hasTextKey && typeof patch.text === 'string' && patch.text !== orig.text
  let newTranslation
  let newTextEdited = orig.is_text_manually_edited
  let newTranslationEdited = orig.is_translation_manually_edited
  if (textChanged) {
    newTextEdited = 1
    if (!hasTranslationKey || patch.translation === undefined) {
      newTranslation = null
      newTranslationEdited = 0
    } else {
      newTranslation = typeof patch.translation === 'string' ? patch.translation : null
      newTranslationEdited = newTranslation !== null ? 1 : 0
    }
  } else if (hasTranslationKey) {
    newTranslation = typeof patch.translation === 'string' ? patch.translation : null
    newTranslationEdited = newTranslation !== null ? 1 : 0
  } else {
    newTranslation = orig.translation
  }
  const ttsStale = textChanged || newTranslation !== orig.translation
  return { newText, newTranslation, newTextEdited, newTranslationEdited, textChanged, ttsStale }
}

// Build proposed state in memory. No DB writes.
// allSegments: DB rows sorted by index_num (must include id, index_num, start_sec,
//   end_sec, text, translation, is_time_manually_adjusted, ...).
// incoming: payload segments [{id, text?, translation?, startSec?, endSec?}].
// Returns { proposed: Map(id->row), ordered: [...rows in index order],
//   adjusted: [...auto-push details], ttsInvalidate: [ids],
//   conflicts: [...], errors: [...] }.
// conflicts/errors non-empty → caller must reject without writing.
export function computeProposedState(allSegments, incoming, { gap = TIMING_GAP, durationSec = null } = {}) {
  const GAP = gap
  const ordered = [...(allSegments || [])]
    .slice()
    .sort((a, b) => (a.index_num ?? 0) - (b.index_num ?? 0))
    .map((r) => ({ ...r }))
  const byId = new Map(ordered.map((r) => [String(r.id), r]))
  const conflicts = []
  const errors = []

  const incomingList = Array.isArray(incoming) ? incoming.filter((s) => s && typeof s === 'object') : []
  // Deterministic: dedupe + sort by index_num, ignore unknown ids (caller counts updated).
  const seenPayload = new Set()
  for (const s of incomingList) {
    const id = String(s.id)
    if (seenPayload.has(id)) {
      conflicts.push({ code: 'DUPLICATE_SEGMENT', segmentId: id, message: `Segment ${id} xuất hiện 2 lần trong batch` })
    } else {
      seenPayload.add(id)
    }
    if (!byId.has(id)) {
      errors.push({ code: 'UNKNOWN_SEGMENT', segmentId: id, message: `Segment ${id} không thuộc project` })
    }
  }
  if (errors.length) return { proposed: byId, ordered, adjusted: [], ttsInvalidate: [], conflicts, errors }

  const incomingById = new Map()
  for (const s of incomingList) {
    const id = String(s.id)
    if (byId.has(id) && !incomingById.has(id)) incomingById.set(id, s)
  }
  // Sort explicit edits by index_num for determinism.
  const explicitOrdered = [...incomingById.entries()]
    .map(([id, patch]) => ({ id, patch, idx: byId.get(id)?.index_num ?? 0 }))
    .sort((a, b) => a.idx - b.idx)

  const ttsInvalidate = []
  const hasExplicitTiming = new Set()
  // Step 1: apply text/translation + explicit timing into clones.
  for (const { id, patch } of explicitOrdered) {
    const row = byId.get(id)
    const t = applyTextTranslation(row, patch)
    row.text = t.newText
    row.translation = t.newTranslation
    row.is_text_manually_edited = t.newTextEdited
    row.is_translation_manually_edited = t.newTranslationEdited
    if (t.ttsStale) ttsInvalidate.push(id)

    const explicitStart = patch.startSec !== undefined ? num(patch.startSec) : null
    const explicitEnd = patch.endSec !== undefined ? num(patch.endSec) : null
    if (explicitStart !== null || explicitEnd !== null) {
      const ns = explicitStart !== null ? explicitStart : row.start_sec
      const ne = explicitEnd !== null ? explicitEnd : row.end_sec
      if (explicitStart !== null && !(explicitStart >= 0)) {
        errors.push({ code: 'INVALID_TIMING', segmentId: id, message: `start phải >= 0 (got ${patch.startSec})` })
        continue
      }
      if (!(ne > ns)) {
        errors.push({ code: 'INVALID_TIMING', segmentId: id, message: `end phải > start (got ${ns}→${ne})` })
        continue
      }
      row.start_sec = ns
      row.end_sec = ne
      row.is_time_manually_adjusted = 1
      hasExplicitTiming.add(id)
    }
  }
  if (errors.length || conflicts.length) {
    return { proposed: byId, ordered, adjusted: [], ttsInvalidate, conflicts, errors }
  }

  // Step 2: minimal forward push in index order.
  const adjusted = []
  for (let i = 0; i < ordered.length; i++) {
    const cur = ordered[i]
    if (i === 0) {
      if (!(cur.start_sec >= 0) || !(cur.end_sec > cur.start_sec)) {
        errors.push({ code: 'INVALID_TIMING', segmentId: String(cur.id), message: `Timing không hợp lệ (${cur.start_sec}→${cur.end_sec})` })
        break
      }
      continue
    }
    const prev = ordered[i - 1]
    const need = prev.end_sec + GAP - cur.start_sec
    if (need > EPS) {
      // Need to move cur forward. If cur was explicitly set in this batch → conflict.
      if (hasExplicitTiming.has(String(cur.id))) {
        conflicts.push({
          code: 'OVERLAP_CONFLICT',
          segmentId: String(cur.id),
          prevSegmentId: String(prev.id),
          prevEnd: prev.end_sec,
          newStart: cur.start_sec,
          message: `Overlap: segment trước (index ${prev.index_num}) kết thúc ${prev.end_sec}s, segment này bắt đầu ${cur.start_sec}s (cần gap ${GAP}s). Cả hai đều sửa trong cùng batch — hãy giãn timing rồi gửi lại.`,
        })
        continue
      }
      if (cur.is_time_manually_adjusted) {
        conflicts.push({
          code: 'OVERLAP_CONFLICT',
          segmentId: String(cur.id),
          conflictSegmentId: String(cur.id),
          message: `Conflict với segment đã chỉnh tay (index ${cur.index_num}). Hãy chỉnh tay segment này.`,
        })
        continue
      }
      const prevStart = cur.start_sec
      const prevEnd = cur.end_sec
      cur.start_sec = prev.end_sec + GAP
      cur.end_sec = prevEnd + (cur.start_sec - prevStart)
      // pushed segments are system-adjusted, not manual
      cur.is_time_manually_adjusted = 0
      adjusted.push({
        id: String(cur.id),
        index: cur.index_num,
        prevStart,
        prevEnd,
        newStart: cur.start_sec,
        newEnd: cur.end_sec,
      })
    }
    if (!(cur.start_sec >= 0) || !(cur.end_sec > cur.start_sec)) {
      errors.push({ code: 'INVALID_TIMING', segmentId: String(cur.id), message: `Timing không hợp lệ sau push (${cur.start_sec}→${cur.end_sec})` })
      break
    }
  }

  // Step 3: duration guard (only when known).
  const dur = num(durationSec)
  if (dur !== null && dur > 0) {
    for (const r of ordered) {
      if (r.end_sec - dur > EPS) {
        errors.push({ code: 'EXCEEDS_DURATION', segmentId: String(r.id), message: `end ${r.end_sec}s vượt video duration ${dur}s` })
        break
      }
    }
  }

  return { proposed: byId, ordered, adjusted, ttsInvalidate, conflicts, errors }
}

// Validate a fully-resolved ordered state. Returns {ok, errors}.
export function validateProposedState(ordered, { gap = TIMING_GAP, durationSec = null } = {}) {
  const GAP = gap
  const errors = []
  const list = [...(ordered || [])].slice().sort((a, b) => (a.index_num ?? 0) - (b.index_num ?? 0))
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    if (!(r.start_sec >= 0)) errors.push({ code: 'NEGATIVE_START', segmentId: String(r.id), message: `start âm (${r.start_sec})` })
    if (!(r.end_sec > r.start_sec)) errors.push({ code: 'INVALID_TIMING', segmentId: String(r.id), message: `end phải > start` })
    if (i > 0) {
      const prev = list[i - 1]
      if (prev.end_sec + GAP - r.start_sec > EPS) {
        errors.push({ code: 'OVERLAP_CONFLICT', segmentId: String(r.id), message: `Overlap với segment trước (index ${prev.index_num})` })
      }
    }
  }
  const dur = Number(durationSec)
  if (Number.isFinite(dur) && dur > 0) {
    for (const r of list) {
      if (r.end_sec - dur > EPS) {
        errors.push({ code: 'EXCEEDS_DURATION', segmentId: String(r.id), message: `Vượt duration ${dur}s` })
        break
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

export default { TIMING_GAP, computeProposedState, validateProposedState, applyTextTranslation }
