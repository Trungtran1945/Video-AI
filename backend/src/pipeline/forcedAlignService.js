import { clamp } from './context.js'

// Forced Alignment (docs/05 §B.5, transflow doc 15 §5.3)
// Ép khớp thời lượng TTS vào slot của câu gốc.
// Pure functions: không I/O, dễ test theo docs/09.
//
// Invariant:
// - Lệch biên mỗi segment < 5% slot sau khi fit
// - Không segment nào chồng lên segment kế (overlap tối đa 0.3s vào khoảng lặng)
// - atempo bị chặn trong [0.8, 1.2] để giọng không méo;
//   ưu tiên RÚT GỌN CÂU thay vì hớt tốc độ quá mức.

// === Constants từ transflow doc 15 §5.3 ===
export const TEMPO_MIN = 0.80   // Tối thiểu time-stretch (tối đa chậm 20%)
export const TEMPO_MAX = 1.20   // Tối đa time-stretch (tối đa nhanh 20%)
export const TOLERANCE = 0.08   // ±8% — dung sai nhỏ, giữ nguyên
export const STRETCH_THRESHOLD = 0.20 // ±20% — ngưỡng xử lý lệch timing
export const MAX_OVERLAP_SEC = 0.3

/**
 * Fit một câu dub vào slot thời gian gốc.
 * Thuật toán theo transflow doc 15 §5.3 — 4 trường hợp rõ ràng:
 *
 * TRƯỜNG HỢP 1: Khớp (±20%) → giữ nguyên tempo, không pad
 * TRƯỜNG HỢP 2: Dài hơn >20% → đề xuất rút gọn câu dịch (shorten)
 * TRƯỜNG HỢP 3: Ngắn hơn >20% → chèn silence padding (30% đầu / 70% cuối)
 * TRƯỜNG HỢP 4: Lệch nhỏ (8-20%) → time-stretch nhẹ + pad
 *
 * @param {number} ttsDur  thời lượng audio TTS thực tế (giây)
 * @param {number} slotDur thời lượng slot gốc = endSec - startSec
 * @param {object} [opts]
 * @param {boolean} [opts.canShorten=true]  cho phép đề xuất rút gọn câu dịch
 * @returns {{
 *   action: 'keep'|'stretch'|'pad'|'shorten',
 *   tempo: number,          // hệ số atempo áp lên audio (1.0 = giữ nguyên)
 *   padBeforeSec: number,   // im lặng chèn trước giọng
 *   padAfterSec: number,    // im lặng chèn sau giọng
 *   effectiveDurSec: number, // thời lượng chiếm trên timeline sau khi fit
 *   targetCharsRatio?: number // tỷ lệ rút gọn câu (chỉ khi action='shorten')
 * }}
 */
export function fitSegment(ttsDur, slotDur, { canShorten = true } = {}) {
  // Edge case: duration rỗng
  if (!(ttsDur > 0) || !(slotDur > 0)) {
    return { action: 'keep', tempo: 1, padBeforeSec: 0, padAfterSec: 0, effectiveDurSec: Math.max(0, ttsDur || 0) }
  }

  const ratio = ttsDur / slotDur

  // ═══ TRƯỜNG HỢP 1: Khớp (±20%) ═══
  // Condition: D_slot*0.80 <= D_tts <= D_slot*1.20
  // Action: Đặt tại startSec, giữ nguyên duration thực tế
  if (ratio >= (1 - STRETCH_THRESHOLD) && ratio <= (1 + STRETCH_THRESHOLD)) {
    return {
      action: 'keep',
      tempo: 1,
      padBeforeSec: 0,
      padAfterSec: 0,
      effectiveDurSec: round3(ttsDur),
    }
  }

  // ═══ TRƯỜNG HỢP 2: Dài hơn slot (>20%) ═══
  // Condition: D_tts > D_slot * 1.20
  // Severity: BLOCKING nếu không thể rút gọn
  // Action: Đề xuất rút gọn câu dịch rồi TTS lại
  if (ratio > 1 + STRETCH_THRESHOLD) {
    // Tính toán cần rút gọn bao nhiêu
    const targetCharsRatio = Math.max(0.55, slotDur / ttsDur)

    // Nếu canShorten = false, vẫn cố gắng stretch tối đa
    if (!canShorten) {
      const tempo = clamp(1 / ratio, TEMPO_MIN, TEMPO_MAX)
      const effectiveDur = ttsDur * tempo
      return {
        action: 'stretch',
        tempo: round3(tempo),
        padBeforeSec: 0,
        padAfterSec: 0,
        effectiveDurSec: round3(effectiveDur),
      }
    }

    return {
      action: 'shorten',
      tempo: 1,
      padBeforeSec: 0,
      padAfterSec: 0,
      effectiveDurSec: round3(slotDur),
      targetCharsRatio,
    }
  }

  // ═══ TRƯỜNG HỢP 3: Ngắn hơn slot (>20%) ═══
  // Condition: D_tts < D_slot * 0.80
  // Severity: NON_BLOCKING
  // Action: Chèn silence padding (30% đầu / 70% cuối)
  if (ratio < 1 - STRETCH_THRESHOLD) {
    const gap = slotDur - ttsDur
    return {
      action: 'pad',
      tempo: 1,
      padBeforeSec: round3(gap * 0.3),
      padAfterSec: round3(gap * 0.7),
      effectiveDurSec: round3(slotDur),
    }
  }

  // ═══ TRƯỜNG HỢP 4: Lệch nhỏ (8-20%) ═══
  // Condition: D_tts lệch 8-20% so với D_slot
  // Severity: NON_BLOCKING
  // Action: Time-stretch nhẹ + pad phần còn lại
  // Tính tempo cần thiết để vừa slot
  const neededTempo = ttsDur / slotDur
  const tempo = clamp(neededTempo, TEMPO_MIN, TEMPO_MAX)
  const effectiveDur = ttsDur / tempo
  const gap = Math.max(0, slotDur - effectiveDur)

  return {
    action: 'stretch',
    tempo: round3(tempo),
    padBeforeSec: round3(gap * 0.3),
    padAfterSec: round3(gap * 0.7),
    effectiveDurSec: round3(effectiveDur + gap),
  }
}

/**
 * Xếp các segment đã fit vào timeline, đảm bảo không chồng tiếng:
 * nếu effectiveDur của segment i tràn sang segment i+1 thì co lại, tối đa
 * overlap 0.3s (docs/05 §B.5 bước 3c).
 *
 * @param {Array<{startSec:number,endSec:number,effectiveDurSec:number}>} segments
 * @returns {Array<{startAtSec:number, endAtSec:number, clipped:boolean}>}
 */
export function sequenceSegments(segments) {
  const out = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const naturalStart = Number(seg.startSec) || 0
    const dur = Math.max(0, Number(seg.effectiveDurSec) || 0)
    let startAt = naturalStart
    let clipped = false

    const prev = out[i - 1]
    if (prev && startAt < prev.endAtSec) {
      // Tràn vào câu trước → đẩy xuống nhưng chỉ chấp nhận overlap ≤ MAX_OVERLAP
      startAt = prev.endAtSec - MAX_OVERLAP_SEC
      if (startAt < prev.startAtSec) startAt = prev.endAtSec
      clipped = true
    }

    let endAt = startAt + dur
    const next = segments[i + 1]
    if (next && endAt > Number(next.startSec) + MAX_OVERLAP_SEC) {
      endAt = Number(next.startSec) + MAX_OVERLAP_SEC
      clipped = true
    }
    if (endAt < startAt) endAt = startAt

    out.push({ startAtSec: round3(startAt), endAtSec: round3(endAt), clipped })
  }
  return out
}

/**
 * Neo mỗi đoạn giọng vào đúng start_sec gốc của câu (timeline video nguồn) và
 * chặp thời lượng sao cho không chồng vào đoạn kế — KHÔNG dịch startAt về sau.
 *
 * Đây là phiên bản thay thế cho sequenceSegments trong dub.ttsAlign: giữ giọng
 * đọc khớp tuyệt đối với thời điểm nhân vật nói trên video, triệt tiêu lệch
 * (chạy trễ) cộng dồn trong hội thoại dày đặc.
 *
 * @param {Array<{startSec:number,endSec:number,effectiveDurSec:number}>} segments
 * @returns {Array<{startAtSec:number, endAtSec:number, clipped:boolean}>}
 */
export function placeSegments(segments) {
  const out = []
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const startAt = Number(seg.startSec) || 0
    const slotDur = Math.max(0.2, (Number(seg.endSec) || 0) - startAt)
    const nextStart = i + 1 < segments.length ? Number(segments[i + 1].startSec) : Infinity
    // Thời lượng tối đa: vừa đủ lấp slot, nhưng không vượt quá start đoạn kế
    let dur = Math.min(Number(seg.effectiveDurSec) || 0, slotDur)
    if (startAt + dur > nextStart) dur = Math.max(0, nextStart - startAt)
    const clipped = dur < (Number(seg.effectiveDurSec) || 0) - 1e-3
    out.push({ startAtSec: round3(startAt), endAtSec: round3(startAt + Math.max(0, dur)), clipped })
  }
  return out
}

/**
 * Deterministic no-overlap check on physical placement.
 * Rejects any startAtSec < prevEndAtSec - 0.05 (tiny documented tolerance only).
 */
export function validateNoOverlap(timeline, toleranceSec = 0.05) {
  const errors = []
  const sorted = [...(timeline || [])].sort((a, b) => (a.startAtSec || 0) - (b.startAtSec || 0))
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i]
    if ((cur.startAtSec || 0) < (prev.endAtSec || 0) - toleranceSec - 1e-6) {
      errors.push(`overlap: ${cur.segmentId || i} starts at ${cur.startAtSec}s before prev ends at ${prev.endAtSec}s`)
    }
    if ((cur.endAtSec || 0) < (cur.startAtSec || 0)) errors.push(`invalid: end<start for ${cur.segmentId || i}`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Invariant check (docs/05): tổng lệch biên mỗi segment < 5% slot và
 * không có cặp nào chồng nhau quá MAX_OVERLAP.
 */
export function validateAlignment(sequenced, sourceSegments) {
  const errors = []
  for (let i = 0; i < sequenced.length; i++) {
    const s = sequenced[i]
    const src = sourceSegments[i]
    if (!src) continue
    const slot = (Number(src.endSec) || 0) - (Number(src.startSec) || 0)
    const placedDur = s.endAtSec - s.startAtSec
    if (slot > 0 && Math.abs(placedDur - slot) / slot > 0.05 + TOLERANCE) {
      errors.push(`segment ${i}: lệch ${(((placedDur - slot) / slot) * 100).toFixed(1)}% so với slot`)
    }
    const prev = sequenced[i - 1]
    if (prev && s.startAtSec < prev.endAtSec - MAX_OVERLAP_SEC - 1e-6) {
      errors.push(`segment ${i}: chồng ${((prev.endAtSec - s.startAtSec)).toFixed(2)}s vào câu trước`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Tính offset render cho segment khi có cut_ranges (transflow doc 15 §4).
 * Khi Render, tính offset ánh xạ sang timeline đã cắt/ghép:
 *   final_start_ms = segment.start_ms − range.start_ms + cumulative_offset(range)
 *   final_end_ms = segment.end_ms − range.start_ms + cumulative_offset(range)
 *
 * @param {{start_ms:number, end_ms:number}} segment
 * @param {Array<{start_ms:number, end_ms:number}>} [cutRanges]
 * @returns {{finalStartMs:number, finalEndMs:number}}
 */
export function calculateRenderOffset(segment, cutRanges) {
  // Nếu không có cutRanges, dùng timeline gốc
  if (!cutRanges || !cutRanges.length) {
    return {
      finalStartMs: Number(segment.start_ms) || 0,
      finalEndMs: Number(segment.end_ms) || 0,
    }
  }

  const segStart = Number(segment.start_ms) || 0
  const segEnd = Number(segment.end_ms) || 0

  // Tìm cut range chứa segment này
  let cumulativeOffset = 0
  for (const range of cutRanges) {
    const rangeStart = Number(range.start_ms) || 0
    const rangeEnd = Number(range.end_ms) || 0

    if (segStart >= rangeStart && segStart < rangeEnd) {
      return {
        finalStartMs: segStart - rangeStart + cumulativeOffset,
        finalEndMs: Math.min(segEnd, rangeEnd) - rangeStart + cumulativeOffset,
      }
    }
    cumulativeOffset += rangeEnd - rangeStart
  }

  // Fallback: dùng timeline gốc (segment nằm ngoài cut_ranges)
  return {
    finalStartMs: segStart,
    finalEndMs: segEnd,
  }
}

/**
 * Validate timing alignment sau khi fit — kiểm tra invariant.
 * @param {Array<{startSec:number, endSec:number, effectiveDurSec:number}>} fitted
 * @param {Array<{startSec:number, endSec:number}>} sourceSegments
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateTimingAlignment(fitted, sourceSegments) {
  const errors = []

  for (let i = 0; i < fitted.length; i++) {
    const f = fitted[i]
    const src = sourceSegments[i]
    if (!src) continue

    const slotDur = (Number(src.endSec) || 0) - (Number(src.startSec) || 0)
    const placedDur = f.effectiveDurSec

    // Kiểm tra lệch biên < 5% slot
    if (slotDur > 0 && Math.abs(placedDur - slotDur) / slotDur > 0.05 + TOLERANCE) {
      errors.push(`segment ${i}: lệch ${(((placedDur - slotDur) / slotDur) * 100).toFixed(1)}% so với slot`)
    }

    // Kiểm tra không chồng tiếng với segment trước
    const prev = fitted[i - 1]
    if (prev && f.startAtSec !== undefined && prev.endAtSec !== undefined) {
      if (f.startAtSec < prev.endAtSec - MAX_OVERLAP_SEC - 1e-6) {
        errors.push(`segment ${i}: chồng ${((prev.endAtSec - f.startAtSec)).toFixed(2)}s vào câu trước`)
      }
    }
  }

  return { ok: errors.length === 0, errors }
}

const round3 = (n) => Math.round(n * 1000) / 1000

export default {
  fitSegment,
  sequenceSegments,
  placeSegments,
  validateNoOverlap,
  validateAlignment,
  validateTimingAlignment,
  calculateRenderOffset,
  TEMPO_MIN,
  TEMPO_MAX,
  TOLERANCE,
  STRETCH_THRESHOLD,
  MAX_OVERLAP_SEC,
}
