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

function normalizeWordForOverlap(word) {
  return String(word ?? '').toLowerCase().replace(/^[.,!?;:…。、！？，；："'“”‘’()[\]{}<>«»—–-]+|[.,!?;:…。、！？，；："'“”‘’()[\]{}<>«»—–-]+$/gu, '').trim()
}

function tokensForOverlap(text) {
  const norm = normalizeTextForLoop(text)
  if (!norm) return []
  return norm.split(/\s+/).filter(Boolean).map(normalizeWordForOverlap).filter(Boolean)
}

// Multi-signal hallucination detector for Whisper loops on silence/music.
// Never drops legitimate speech on a single signal alone (notably never on
// noSpeechProb >= 0.85 by itself). Combines:
//   - noSpeechProb (high >=0.85, veryHigh >=0.95)
//   - avgLogprob (low <=-1.0 suspicious, good >=-0.5 confident)
//   - duration (short audio with long repetitive text)
//   - repetition (token/char loops)
//   - placeholder patterns (music/silence/noise/...)
export function isHallucinatedText(text, { noSpeechProb, no_speech_prob, avgLogprob, avg_logprob, durationSec, start, end } = {}) {
  const raw = String(text ?? '').trim()
  if (!raw) return true
  const norm = normalizeTextForLoop(raw)
  if (!norm) return true

  const noSpeech = typeof noSpeechProb === 'number' ? noSpeechProb
    : typeof no_speech_prob === 'number' ? no_speech_prob : NaN
  const logprob = typeof avgLogprob === 'number' ? avgLogprob
    : typeof avg_logprob === 'number' ? avg_logprob : NaN
  const hasNoSpeech = Number.isFinite(noSpeech)
  const hasLogprob = Number.isFinite(logprob)
  const veryHighNoSpeech = hasNoSpeech && noSpeech >= 0.95
  const lowLogprob = hasLogprob && logprob <= -1.0
  const goodLogprob = hasLogprob && logprob >= -0.5

  let duration = Number(durationSec)
  if (!Number.isFinite(duration) && Number.isFinite(Number(start)) && Number.isFinite(Number(end))) {
    duration = Number(end) - Number(start)
  }
  const hasDuration = Number.isFinite(duration) && duration >= 0

  // Repetition analysis
  const noSpaces = norm.replace(/\s+/g, '')
  const distinctChars = new Set([...noSpaces])
  const isCjkLoop = noSpaces.length >= 12 && distinctChars.size <= 2
  const tokens = norm.split(/\s+/).filter(Boolean)
  const uniqTokens = new Set(tokens)
  const singleTokenLoop = tokens.length >= 5 && uniqTokens.size === 1
  const twoTokenLoop = tokens.length >= 8 && uniqTokens.size <= 2
  const strongSingleLoop = tokens.length >= 10 && uniqTokens.size === 1
  const strongTwoLoop = tokens.length >= 12 && uniqTokens.size <= 2
  const strongRepetition = isCjkLoop || strongSingleLoop || strongTwoLoop
  const moderateRepetition = singleTokenLoop || twoTokenLoop

  const placeholderMatch = /^(music|silence|noise|applause|laughter|musica|musique|silencio)[\s.]*(\1[\s.]*)*$/i.test(norm) && tokens.length >= 3
  const longPlaceholder = placeholderMatch && tokens.length >= 6

  // Strong structural loops are hallucinations even without acoustic signals
  // (matches legacy behavior for obvious Whisper feedback loops).
  if (strongRepetition) return true
  if (longPlaceholder) return true

  // Good acoustic confidence rescues moderate/placeholder/silence cases.
  // Noisy-speech guard: high noSpeechProb + good avgLogprob → keep.
  // Legitimate repeated phrases (good avgLogprob) are kept here.
  if (goodLogprob) return false

  // Moderate repetition / placeholder: drop unless rescued above.
  // Preserves legacy behavior when acoustic info is absent (unknown → drop
  // obvious loops), but never drops on noSpeechProb alone for normal text.
  if (moderateRepetition) return true
  if (placeholderMatch) return true

  // Silence hallucination: very high noSpeech + low confidence + short segment
  // with non-trivial text. Requires all three to avoid dropping legit speech.
  if (veryHighNoSpeech && lowLogprob && hasDuration && duration < 3 && tokens.length >= 3) return true

  // High noSpeech alone, low logprob alone, or short duration alone → keep.
  // This is the safety fix: no single acoustic-signal hard delete.
  return false
}

export function filterHallucinatedSegments(segments) {
  const list = Array.isArray(segments) ? segments : []
  return list.filter((s) => {
    const text = String(s?.text ?? '').trim()
    if (!text) return false
    const start = Number(s?.start)
    const end = Number(s?.end)
    const durationSec = (Number.isFinite(start) && Number.isFinite(end)) ? (end - start) : undefined
    if (isHallucinatedText(text, {
      noSpeechProb: s?.noSpeechProb ?? s?.no_speech_prob,
      avgLogprob: s?.avgLogprob ?? s?.avg_logprob,
      durationSec,
    })) return false
    return true
  })
}

const OVERLAP_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'is', 'it',
  'that', 'this', 'for', 'with', 'as', 'at', 'by', 'from', 'you', 'we',
  'va', 'la', 'cua', 'của', 'và', 'et', 'le', 'la', 'de', 'und', 'der',
])

function longestSuffixPrefixOverlap(prevTokens, currTokens) {
  const maxK = Math.min(prevTokens.length, currTokens.length)
  for (let k = maxK; k >= 1; k -= 1) {
    let match = true
    for (let i = 0; i < k; i += 1) {
      if (prevTokens[prevTokens.length - k + i] !== currTokens[i]) {
        match = false
        break
      }
    }
    if (match) return k
  }
  return 0
}

function isValidSingleWordOverlap(word) {
  const w = String(word ?? '')
  if (w.length < 4) return false
  if (OVERLAP_STOPWORDS.has(w)) return false
  return true
}

function hasCjkChars(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(text ?? ''))
}

function longestSuffixPrefixChars(prevStr, currStr, minLen = 4) {
  const a = String(prevStr ?? '')
  const b = String(currStr ?? '')
  const maxK = Math.min(a.length, b.length)
  for (let k = maxK; k >= minLen; k -= 1) {
    if (a.slice(a.length - k) === b.slice(0, k)) return k
  }
  return 0
}

// Stitch overlap window between adjacent chunks.
// Chunking uses STT_CHUNK_SEC=300 with STT_OVERLAP_SEC=15, so adjacent
// chunks share up to 15s of audio. Timing gate is asymmetric:
// - forward gap: gap < windowSec (default 1.0, small discontinuity allowed)
// - negative overlap: gap >= -overlapSec (default STT_OVERLAP_SEC)
// Text gate is unchanged in spirit:
// - Exact duplicates within window → drop later (legacy behavior).
// - Suffix/prefix word overlap (e.g. A ends "... everyone welcome",
//   B starts "everyone welcome ...") → merge into one segment:
//   "Hello everyone welcome to the show" with start=prev.start,
//   end=max(prev.end, curr.end). Original casing/punctuation preserved.
// - CJK/no-space fallback: char-level suffix/prefix (≥4 chars).
// - Never merges independent sentences: requires timing gate AND meaningful
//   overlap (≥2 words, or 1 long non-stopword, or ≥4 CJK chars).
//   Low-similarity pairs are kept separate.
export function dedupeOverlapSegments(sortedSegments, { windowSec = 1.0, overlapSec = STT_OVERLAP_SEC } = {}) {
  const list = [...(sortedSegments || [])].sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))
  const maxOverlap = Number.isFinite(Number(overlapSec)) && Number(overlapSec) > 0 ? Number(overlapSec) : STT_OVERLAP_SEC
  const out = []
  for (const seg of list) {
    const prev = out[out.length - 1]
    if (!prev) {
      out.push(seg)
      continue
    }
    const gap = (Number(seg.start) || 0) - (Number(prev.end) || 0)
    if (!(gap < windowSec && gap >= -maxOverlap)) {
      out.push(seg)
      continue
    }
    const prevNorm = normalizeTextForLoop(prev.text)
    const currNorm = normalizeTextForLoop(seg.text)
    if (!prevNorm || !currNorm) {
      out.push(seg)
      continue
    }
    if (prevNorm === currNorm) continue

    const prevTokens = tokensForOverlap(prev.text)
    const currTokens = tokensForOverlap(seg.text)
    if (prevTokens.length === 0 || currTokens.length === 0) {
      out.push(seg)
      continue
    }
    let k = longestSuffixPrefixOverlap(prevTokens, currTokens)
    // CJK / no-space fallback: token overlap is 0 for languages without
    // spaces (single-token sentences). Try char-level suffix/prefix on
    // normalized no-space strings (min 4 chars) before giving up.
    let cjkK = 0
    if (k <= 0) {
      const prevNoSpace = prevNorm.replace(/\s+/g, '')
      const currNoSpace = currNorm.replace(/\s+/g, '')
      const looksCjk = hasCjkChars(prev.text) || hasCjkChars(seg.text)
        || (prevTokens.length <= 1 && currTokens.length <= 1 && prevNoSpace.length >= 6 && currNoSpace.length >= 6)
      if (looksCjk && prevNoSpace && currNoSpace) {
        cjkK = longestSuffixPrefixChars(prevNoSpace, currNoSpace, 4)
        if (cjkK >= 4) {
          // Full containment at char level → drop curr.
          if (cjkK >= currNoSpace.length) continue
          const prevOrig = String(prev.text ?? '').trim()
          const currOrig = String(seg.text ?? '').trim()
          // Map normalized char overlap to original: when test strings carry
          // no punctuation the counts align; otherwise fall back to suffix
          // search on the raw strings.
          let mergedText = ''
          const rawK = longestSuffixPrefixChars(prevOrig, currOrig, 1)
          if (rawK >= 4) {
            mergedText = (prevOrig + currOrig.slice(rawK)).trim()
          } else {
            mergedText = (prevOrig + currOrig.slice(cjkK)).trim()
          }
          if (!mergedText) {
            out.push(seg)
            continue
          }
          const mergedCjk = {
            ...prev,
            text: mergedText,
            start: prev.start,
            end: Math.max(Number(prev.end) || 0, Number(seg.end) || 0),
          }
          if ((mergedCjk.speaker == null) && (seg.speaker != null)) mergedCjk.speaker = seg.speaker
          if ((mergedCjk.language == null) && (seg.language != null)) mergedCjk.language = seg.language
          out[out.length - 1] = mergedCjk
          continue
        }
      }
      out.push(seg)
      continue
    }
    if (k === 1 && !isValidSingleWordOverlap(currTokens[0])) {
      out.push(seg)
      continue
    }
    // Full containment: curr entirely inside prev overlap → drop curr.
    if (k >= currTokens.length) continue

    // Merge: prev original words + curr original words after overlap.
    const prevWordsOrig = String(prev.text ?? '').trim().split(/\s+/).filter(Boolean)
    const currWordsOrig = String(seg.text ?? '').trim().split(/\s+/).filter(Boolean)
    // Map normalized overlap k to original word offset: normalized token
    // count may be ≤ original word count when punctuation-only tokens are
    // stripped; align from the front by skipping empty normalized words.
    let currOrigSkip = 0
    let seen = 0
    for (let i = 0; i < currWordsOrig.length && seen < k; i += 1) {
      const nw = normalizeWordForOverlap(currWordsOrig[i])
      currOrigSkip += 1
      if (nw) seen += 1
    }
    const mergedText = [...prevWordsOrig, ...currWordsOrig.slice(currOrigSkip)].join(' ').trim()
    if (!mergedText) {
      out.push(seg)
      continue
    }
    const merged = {
      ...prev,
      text: mergedText,
      start: prev.start,
      end: Math.max(Number(prev.end) || 0, Number(seg.end) || 0),
    }
    // Preserve speaker/language from prev (chunk-boundary continuity);
    // if prev lacks them but curr has them, inherit curr's.
    if ((merged.speaker == null) && (seg.speaker != null)) merged.speaker = seg.speaker
    if ((merged.language == null) && (seg.language != null)) merged.language = seg.language
    out[out.length - 1] = merged
  }
  return out
}

// sha256 of file content for ASR cache keys (path alone is not stable:
// tmp paths are reused across runs with different audio).
// Streaming: never loads the whole audio file into RAM just to hash.
export async function hashFileContent(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      try {
        resolve(hash.digest('hex'))
      } catch (err) {
        reject(err)
      }
    })
  })
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
