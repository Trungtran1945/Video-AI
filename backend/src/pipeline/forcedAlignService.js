import { clamp } from './context.js'

// Forced Alignment (docs/05 §B.5) — ép khớp thời lượng TTS vào slot của câu gốc.
// Pure functions: không I/O, dễ test theo docs/09.
//
// Invariant:
// - Lệch biên mỗi segment < 5% slot sau khi fit
// - Không segment nào chồng lên segment kế (overlap tối đa 0.3s vào khoảng lặng)
// - atempo bị chặn trong [0.9, 1.15] để giọng không méo;
//   ưu tiên RÚT GỌN CÂU thay vì hớt tốc độ.

export const TEMPO_MIN = 0.94
export const TEMPO_MAX = 1.06
export const TOLERANCE = 0.08 // ±8%
export const MAX_OVERLAP_SEC = 0.3

/**
 * Fit một câu dub vào slot thời gian gốc.
 * @param {number} ttsDur  thời lượng audio TTS thực tế (giây)
 * @param {number} slotDur thời lượng slot gốc = endSec - startSec
 * @param {object} [opts]
 * @param {boolean} [opts.canShorten=true]  cho phép đề xuất rút gọn câu dịch
 * @returns {{
 *   action: 'keep'|'speed'|'slow'|'pad'|'shorten',
 *   tempo: number,          // hệ số atempo áp lên audio (1.0 = giữ nguyên)
 *   padBeforeSec: number,   // im lặng chèn trước giọng
 *   padAfterSec: number,    // im lặng chèn sau giọng
 *   effectiveDurSec: number // thời lượng chiếm trên timeline sau khi fit
 * }}
 */
export function fitSegment(ttsDur, slotDur, { canShorten = true } = {}) {
  if (!(ttsDur > 0) || !(slotDur > 0)) {
    return { action: 'keep', tempo: 1, padBeforeSec: 0, padAfterSec: 0, effectiveDurSec: Math.max(0, ttsDur || 0) }
  }

  const ratio = ttsDur / slotDur

  // Trong dung sai ±8% → dùng nguyên xi
  if (ratio >= 1 - TOLERANCE && ratio <= 1 + TOLERANCE) {
    return { action: 'keep', tempo: 1, padBeforeSec: 0, padAfterSec: 0, effectiveDurSec: round3(ttsDur) }
  }

  // Đọc dài hơn slot → tăng tốc nhẹ; vẫn thừa → đề xuất rút gọn câu dịch
  if (ratio > 1 + TOLERANCE) {
    const needed = clamp(ratio, 1.0, TEMPO_MAX)
    const afterTempo = ttsDur / needed
    if (afterTempo > slotDur * (1 + TOLERANCE)) {
      // Vượt cả khi đã hớt tốc độ tối đa → phải rút gọn bản dịch rồi TTS lại
      return {
        action: canShorten ? 'shorten' : 'speed',
        tempo: needed,
        padBeforeSec: 0,
        padAfterSec: 0,
        effectiveDurSec: round3(afterTempo),
        targetCharsRatio: Math.max(0.55, slotDur / ttsDur), // rút còn ~X% độ dài
      }
    }
    return { action: 'speed', tempo: round3(needed), padBeforeSec: 0, padAfterSec: 0, effectiveDurSec: round3(afterTempo) }
  }

  // Ngắn hơn slot → chèn lặng (30% đầu / 70% cuối); lệch nhiều thì chậm nhẹ
  if (ratio < 1 - TOLERANCE) {
    if (ratio >= TEMPO_MIN) {
      // Chênh ít: chậm nhẹ về gần khớp rồi pad phần còn lại
      const tempo = round3(Math.max(TEMPO_MIN, slotDur / ttsDur <= TEMPO_MIN ? TEMPO_MIN : slotDur / ttsDur))
      const eff = ttsDur / tempo
      const gap = Math.max(0, slotDur - eff)
      return {
        action: 'pad',
        tempo,
        padBeforeSec: round3(gap * 0.3),
        padAfterSec: round3(gap * 0.7),
        effectiveDurSec: round3(eff + gap),
      }
    }
    const gap = slotDur - ttsDur
    return {
      action: 'pad',
      tempo: 1,
      padBeforeSec: round3(gap * 0.3),
      padAfterSec: round3(gap * 0.7),
      effectiveDurSec: round3(slotDur),
    }
  }

  return { action: 'keep', tempo: 1, padBeforeSec: 0, padAfterSec: 0, effectiveDurSec: round3(ttsDur) }
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

const round3 = (n) => Math.round(n * 1000) / 1000

export default {
  fitSegment,
  sequenceSegments,
  validateAlignment,
  TEMPO_MIN,
  TEMPO_MAX,
  TOLERANCE,
  MAX_OVERLAP_SEC,
}
