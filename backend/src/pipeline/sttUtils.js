import crypto from 'node:crypto'
import fs from 'node:fs'

// Shared STT helpers for dub.stt + summary.transcribe.
// Keeps language handling, chunking and hallucination filtering in one place
// so both branches behave identically.

export const STT_CHUNK_SEC = 300
export const STT_OVERLAP_SEC = 15

// Whisper expects ISO-639-1 ('vi', 'zh', 'en'...). 'auto'/''/unknown →
// undefined so the API auto-detects instead of erroring on bad codes.
export function normalizeSttLanguage(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw === 'auto' || raw === 'unknown' || raw === 'null' || raw === 'undefined') return undefined
  const base = raw.replace(/_/g, '-').split('-')[0]
  if (!/^[a-z]{2,3}$/.test(base)) return undefined
  return base
}

// STT source language comes from params.sourceLanguage only.
// Never fall back to project.language (that field holds the TARGET language
// for TRANSLATE_DUB and the summary language for SUMMARY).
export function resolveSttSourceLanguage(project) {
  let params = {}
  try { params = project?.params ? JSON.parse(project.params) : {} } catch (_) { params = {} }
  const fromParams = normalizeSttLanguage(params.sourceLanguage)
  if (fromParams) return fromParams
  return undefined
}

// Build overlapping chunks: step = chunkSec - overlapSec.
// Short audio → single chunk covering full duration.
export function buildSttChunks(durationSec, { chunkSec = STT_CHUNK_SEC, overlapSec = STT_OVERLAP_SEC } = {}) {
  const total = Number(durationSec) || 0
  if (!(total > 0)) return []
  const cs = Math.max(30, Number(chunkSec) || STT_CHUNK_SEC)
  const ov = Math.min(Math.max(0, Number(overlapSec) || 0), Math.floor(cs / 2))
  if (total <= cs) return [{ index: 0, start: 0, dur: Math.round(total * 100) / 100 }]
  const step = cs - ov
  const chunks = []
  let start = 0
  let index = 0
  while (start < total) {
    const dur = Math.min(cs, total - start)
    chunks.push({ index: index++, start: Math.round(start * 100) / 100, dur: Math.round(dur * 100) / 100 })
    if (start + dur >= total) break
    start += step
  }
  return chunks
}

function normalizeTextForLoop(text) {
  return String(text ?? '').trim().toLowerCase().replace(/[.,!?;:…。、！？，；：\s]+/gu, ' ').trim()
}

// Heuristic hallucination detector for Whisper loops on silence/music:
// blank, single token/char repeated, or high no_speech_prob.
export function isHallucinatedText(text, { noSpeechProb } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return true
  if (typeof noSpeechProb === 'number' && noSpeechProb >= 0.85) return true
  const norm = normalizeTextForLoop(raw)
  if (!norm) return true
  // CJK: very few distinct chars over a long string → loop
  const noSpaces = norm.replace(/\s+/g, '')
  const distinct = new Set([...noSpaces])
  if (noSpaces.length >= 12 && distinct.size <= 2) return true
  // Alphabetic: one word repeated ≥5 times, or ≤2 distinct words with ≥6 tokens
  const tokens = norm.split(/\s+/).filter(Boolean)
  if (tokens.length >= 5) {
    const uniq = new Set(tokens)
    if (uniq.size === 1) return true
    if (uniq.size <= 2 && tokens.length >= 8) return true
  }
  // Long dash/music placeholders Whisper emits on silence
  if (/^(music|silence|noise|applause|laughter)[\s.]*(\1[\s.]*)*$/i.test(norm) && tokens.length >= 3) return true
  return false
}

export function filterHallucinatedSegments(segments) {
  const list = Array.isArray(segments) ? segments : []
  return list.filter((s) => {
    const text = String(s?.text ?? '').trim()
    if (!text) return false
    if (isHallucinatedText(text, { noSpeechProb: s?.noSpeechProb ?? s?.no_speech_prob })) return false
    return true
  })
}

// Drop duplicate segments produced in the overlap window of adjacent chunks.
// Keeps first occurrence; drops later ones with (near-)identical text starting
// within `windowSec` of previous end.
export function dedupeOverlapSegments(sortedSegments, { windowSec = 1.0 } = {}) {
  const list = [...(sortedSegments || [])].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))
  const out = []
  for (const seg of list) {
    const prev = out[out.length - 1]
    if (prev) {
      const gap = (Number(seg.start) || 0) - (Number(prev.end) || 0)
      const sameText = normalizeTextForLoop(seg.text) === normalizeTextForLoop(prev.text)
      if (sameText && gap < windowSec) continue
    }
    out.push(seg)
  }
  return out
}

// sha256 of file content for ASR cache keys (path alone is not stable:
// tmp paths are reused across runs with different audio).
export function hashFileContent(filePath) {
  const buffer = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export default {
  STT_CHUNK_SEC,
  STT_OVERLAP_SEC,
  normalizeSttLanguage,
  resolveSttSourceLanguage,
  buildSttChunks,
  isHallucinatedText,
  filterHallucinatedSegments,
  dedupeOverlapSegments,
  hashFileContent,
}
