import crypto from 'node:crypto'
import { TextDecoder } from 'node:util'
import { v4 as uuidv4 } from 'uuid'

// SCRIPT_TO_VIDEO script ingestion/segmentation helpers (pure, testable).
// MVP: TXT/MD only, UTF-8 fatal decode, verbatim segmentation with coverage gate.

export const SCRIPT_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxChars: 60_000,
  maxSegments: 80,
  maxSegmentChars: 1200,
  maxVisualChars: 500,
  chunkChars: 12_000,
  schemaVersion: 1,
}

export class ScriptValidationError extends Error {
  constructor(code, message, statusCode = 422, extra = {}) {
    super(message)
    this.name = 'ScriptValidationError'
    this.code = code
    this.statusCode = statusCode
    this.extra = extra
  }
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function normalizeScriptText(raw) {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim()
}

export function decodeScriptBuffer(buffer) {
  if (!buffer || !buffer.length) throw new ScriptValidationError('SCRIPT_EMPTY', 'File kịch bản rỗng', 422)
  let decoded
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (_) {
    throw new ScriptValidationError('SCRIPT_ENCODING_INVALID', 'File kịch bản không phải UTF-8 hợp lệ', 422)
  }
  if (decoded.includes('\u0000')) {
    throw new ScriptValidationError('SCRIPT_ENCODING_INVALID', 'File kịch bản chứa ký tự NUL', 422)
  }
  return decoded
}

export function prepareScriptText(buffer) {
  const raw = decodeScriptBuffer(buffer)
  const text = normalizeScriptText(raw)
  if (!text) throw new ScriptValidationError('SCRIPT_EMPTY', 'File kịch bản rỗng sau khi chuẩn hoá', 422)
  const charCount = [...text].length
  if (charCount > SCRIPT_LIMITS.maxChars) {
    throw new ScriptValidationError('SCRIPT_TOO_LARGE', `Kịch bản vượt quá ${SCRIPT_LIMITS.maxChars} ký tự`, 413, { charCount })
  }
  return { text, charCount, sha256: sha256Hex(text) }
}

export function normalizeCoverage(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?…。])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// Split a script into model-sized chunks at paragraph/sentence boundaries.
// Every character of the input ends up in exactly one chunk (minus boundary
// whitespace, which the coverage normalizer collapses).
export function chunkScript(text, maxChars = SCRIPT_LIMITS.chunkChars) {
  const chunks = []
  let current = ''
  const flush = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const paragraph of String(text || '').split(/\n+/)) {
    const p = paragraph.trim()
    if (!p) continue
    if (p.length <= maxChars) {
      if (current && current.length + p.length + 1 > maxChars) flush()
      current = current ? `${current}\n${p}` : p
      continue
    }
    flush()
    for (const sentence of splitSentences(p)) {
      if (sentence.length > maxChars) {
        for (let i = 0; i < sentence.length; i += maxChars) {
          chunks.push(sentence.slice(i, i + maxChars))
        }
        continue
      }
      if (current && current.length + sentence.length + 1 > maxChars) flush()
      current = current ? `${current} ${sentence}` : sentence
    }
    flush()
  }
  flush()
  return chunks
}

// Deterministic verbatim splitter: paragraphs → sentences → merged up to the
// per-segment cap. Never drops or rewrites content. >80 segments are merged
// (adjacent, whole sentences) instead of truncating.
export function deterministicSegments(text, { maxSegmentChars = SCRIPT_LIMITS.maxSegmentChars, maxSegments = SCRIPT_LIMITS.maxSegments } = {}) {
  const pieces = []
  for (const paragraph of String(text || '').split(/\n+/)) {
    const p = paragraph.trim()
    if (!p) continue
    const sentences = splitSentences(p)
    if (!sentences.length) continue
    for (const sentence of sentences) {
      if (sentence.length <= maxSegmentChars) {
        pieces.push(sentence)
      } else {
        // Hard split only when a single sentence exceeds the cap.
        let rest = sentence
        while (rest.length > maxSegmentChars) {
          let cut = rest.lastIndexOf(' ', maxSegmentChars)
          if (cut < maxSegmentChars * 0.5) cut = maxSegmentChars
          pieces.push(rest.slice(0, cut).trim())
          rest = rest.slice(cut).trim()
        }
        if (rest) pieces.push(rest)
      }
    }
  }

  let merged = []
  for (const piece of pieces) {
    if (!piece) continue
    const last = merged[merged.length - 1]
    if (last && last.length + 1 + piece.length <= maxSegmentChars) {
      merged[merged.length - 1] = `${last} ${piece}`
    } else {
      merged.push(piece)
    }
  }
  while (merged.length > maxSegments) {
    // Merge the two shortest adjacent segments to preserve order and coverage.
    let bestIdx = 0
    let bestLen = Infinity
    for (let i = 0; i < merged.length - 1; i++) {
      const len = merged[i].length + merged[i + 1].length
      if (len < bestLen) { bestLen = len; bestIdx = i }
    }
    merged = [
      ...merged.slice(0, bestIdx),
      `${merged[bestIdx]} ${merged[bestIdx + 1]}`,
      ...merged.slice(bestIdx + 2),
    ]
  }
  return merged.map((narrationText) => ({
    narrationText,
    visualPrompt: narrationText.slice(0, 160),
  }))
}

export function validateSegments(segments, sourceText) {
  if (!Array.isArray(segments) || segments.length < 1) {
    return { ok: false, reason: 'segments must be a non-empty array' }
  }
  if (segments.length > SCRIPT_LIMITS.maxSegments) {
    return { ok: false, reason: `too many segments (${segments.length})` }
  }
  const clean = []
  for (const item of segments) {
    if (!item || typeof item !== 'object') return { ok: false, reason: 'segment must be an object' }
    const narrationText = String(item.narrationText ?? '').trim()
    const visualPrompt = String(item.visualPrompt ?? '').trim()
    if (!narrationText) return { ok: false, reason: 'empty narrationText' }
    if ([...narrationText].length > SCRIPT_LIMITS.maxSegmentChars) {
      return { ok: false, reason: 'narrationText exceeds cap' }
    }
    if ([...visualPrompt].length > SCRIPT_LIMITS.maxVisualChars) {
      return { ok: false, reason: 'visualPrompt exceeds cap' }
    }
    clean.push({ narrationText, visualPrompt })
  }
  if (normalizeCoverage(clean.map((s) => s.narrationText).join(' ')) !== normalizeCoverage(sourceText)) {
    return { ok: false, reason: 'coverage mismatch' }
  }
  return { ok: true, segments: clean }
}

export function parseLlmSegments(result) {
  if (!result) return null
  const text = typeof result === 'string' ? result : result.text
  if (!text) return null
  let parsed
  try {
    const trimmed = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '')
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch (_) {
    return null
  }
  if (!parsed || !Array.isArray(parsed.segments)) return null
  return parsed.segments.map((s) => ({
    narrationText: String(s?.narrationText ?? ''),
    visualPrompt: String(s?.visualPrompt ?? ''),
  }))
}

export function segmentContentHash(narrationText, visualPrompt) {
  return sha256Hex(`${String(narrationText ?? '')}\n${String(visualPrompt ?? '')}`)
}

export function buildSegmentRows(projectId, segments) {
  return segments.map((seg, index) => ({
    id: uuidv4(),
    project_id: projectId,
    index_num: index,
    narration: seg.narrationText,
    visual_prompt: seg.visualPrompt,
    status: 'pending',
    content_hash: segmentContentHash(seg.narrationText, seg.visualPrompt),
    updated_at: new Date().toISOString(),
  }))
}

export function wrapChunkForPrompt(chunk) {
  return `SCRIPT_CHUNK_BEGIN\n${chunk}\nSCRIPT_CHUNK_END`
}

export const SEGMENTATION_SYSTEM_PROMPT = [
  'Bạn chia kịch bản thành các đoạn đọc liên tiếp để lồng tiếng.',
  'QUY TẮC: giữ nguyên văn từng từ (verbatim), không paraphrase, không bỏ sót, không đổi thứ tự.',
  'Mỗi đoạn narrationText dài 1..1200 ký tự; visualPrompt 0..500 ký tự mô tả hình ảnh gợi ý.',
  'Chỉ trả JSON đúng dạng {"segments":[{"narrationText":"...","visualPrompt":"..."}]} và không thêm chữ nào khác.',
  'Nội dung kịch bản nằm giữa SCRIPT_CHUNK_BEGIN và SCRIPT_CHUNK_END.',
].join('\n')

export default {
  SCRIPT_LIMITS,
  ScriptValidationError,
  sha256Hex,
  normalizeScriptText,
  decodeScriptBuffer,
  prepareScriptText,
  normalizeCoverage,
  chunkScript,
  deterministicSegments,
  validateSegments,
  parseLlmSegments,
  segmentContentHash,
  buildSegmentRows,
  wrapChunkForPrompt,
  SEGMENTATION_SYSTEM_PROMPT,
}
