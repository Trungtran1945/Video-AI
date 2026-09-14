import path from 'path'
import fs from 'node:fs'
import { v4 as uuidv4 } from 'uuid'
import { insert, query } from '../../db/query.js'
import { sampleFrames, probe } from '../../media/mediaService.js'
import { getProvider } from '../../providers/registry.js'
import { callProvider } from '../../lib/callProvider.js'
import { projectDir, tmpDirOf, ensureDir, requireSourceFile, round2 } from '../context.js'

export async function dubOcr(ctx) {
  const { project, job, setProgress, results, signal } = ctx
  const ingest = results['dub.ingest'] || {}
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const tmp = ensureDir(tmpDirOf(project.id))
  setProgress(2)

  if (signal?.aborted) throw new Error('Cancelled')

  // Skip if segments already exist (cached from duplicate project)
  const existing = await query(
    'SELECT COUNT(*) as cnt FROM transcript_segments WHERE project_id = ?',
    [project.id]
  )
  if (existing[0]?.cnt > 0) {
    return { segmentCount: existing[0].cnt, skipped: true, reason: 'cached' }
  }

  const params = parseParams(project.params)
  const sourceLanguage = params.sourceLanguage || 'auto'
  const durationSec = ingest.durationSec || (await probe(src)).durationSec || 0
  const width = ingest.width || 1280
  const height = ingest.height || 720

  // Temporal sampling: 2 FPS default (env OCR_FPS), cap 900 — adaptive via sampleFrames
  const framesDir = path.join(tmp, 'ocr_frames')
  const fps = Number(process.env.OCR_FPS || 2)
  const cap = Number(process.env.OCR_CAP || 900)
  const frames = await sampleFrames(src, framesDir, { fps, cap })
  setProgress(5)

  if (frames.length === 0) {
    throw new Error('Không trích xuất được frame nào từ video')
  }

  // Get OCR provider
  const ocr = await getProvider(project.user_id, 'ocr')

  // Run OCR on each frame
  const allBoxes = []
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) throw new Error('Cancelled')

    const frame = frames[i]
    const result = await callProvider({
      provider: ocr.id,
      type: 'ocr',
      model: ocr.provider.model || ocr.id,
      input: { imagePath: frame.file, width, height, sourceLanguage },
      fn: () => ocr.provider.detectSubtitle({ imagePath: frame.file, width, height, sourceLanguage }),
      userId: project.user_id,
      apiKeyId: ocr.apiKeyId,
      projectId: project.id,
      jobId: job.id,
    })

    for (const box of result.boxes || []) {
      allBoxes.push({ ...box, timestamp: frame.t })
    }

    setProgress(5 + Math.round(((i + 1) / frames.length) * 55))
  }

  // Aggregate OCR results into segments (temporal + fuzzy + bbox)
  const frameStep = frames.length > 1 ? Math.abs((frames[1]?.t ?? 1) - (frames[0]?.t ?? 0)) || 1 / fps : 1 / fps
  const segments = aggregateBoxes(allBoxes, durationSec, fps, { frameStep, height })
  setProgress(65)

  // Write to transcript_segments
  for (const seg of segments) {
    seg.project_id = project.id
    await insert('transcript_segments', seg)
  }

  // Cleanup frame files
  try { fs.rmSync(framesDir, { recursive: true, force: true }) } catch {}

  setProgress(100)

  return {
    segmentCount: segments.length,
    language: sourceLanguage !== 'auto' ? sourceLanguage : null,
  }
}

const OCR_MIN_CONF = () => Number(process.env.OCR_MIN_CONF || 0.55)
const TEXT_SIM_THRESHOLD = 0.82

export function normalizeText(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u1ef9\u3040-\u30ff\u4e00-\u9fff ]/gi, ' ').replace(/\s+/g, ' ').trim()
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 1; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[m][n]
}

export function textSim(a, b) {
  const na = normalizeText(a), nb = normalizeText(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const maxLen = Math.max(na.length, nb.length)
  const lev = 1 - levenshtein(na, nb) / maxLen
  const setA = new Set(na.split(' ')), setB = new Set(nb.split(' '))
  let inter = 0
  for (const w of setA) if (setB.has(w)) inter++
  const jaccard = inter / Math.max(1, new Set([...setA, ...setB]).size)
  return Math.max(lev, jaccard)
}

export function bboxCompatible(a, b, frameH = 720) {
  const h = Number(frameH) || 720
  const ay = Number(a?.y), by = Number(b?.y)
  if (!Number.isFinite(ay) || !Number.isFinite(by)) return true
  if (Math.abs(ay - by) > h * 0.08) return false
  const ax0 = Number(a.x) || 0, ax1 = ax0 + (Number(a.width) || 0)
  const bx0 = Number(b.x) || 0, bx1 = bx0 + (Number(b.width) || 0)
  const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
  const minW = Math.max(1, Math.min(ax1 - ax0, bx1 - bx0))
  return overlap / minW > 0.3
}

export function aggregateBoxes(allBoxes, durationSec, fps = 2, opts = {}) {
  if (!allBoxes.length) return []
  const frameStep = opts.frameStep || 1 / fps
  const frameH = opts.height || 720
  const minConf = OCR_MIN_CONF()
  const dur = Number(durationSec) || 0

  allBoxes.sort((a, b) => a.timestamp - b.timestamp || (a.y || 0) - (b.y || 0))

  const groups = []
  let cur = [allBoxes[0]]
  for (let i = 1; i < allBoxes.length; i++) {
    const prev = allBoxes[i - 1]
    const currBox = allBoxes[i]
    const dt = currBox.timestamp - prev.timestamp
    if (dt <= 1.2 && textSim(currBox.text, prev.text) >= TEXT_SIM_THRESHOLD && bboxCompatible(currBox, prev, frameH)) {
      cur.push(currBox)
    } else {
      groups.push(cur)
      cur = [currBox]
    }
  }
  groups.push(cur)

  const prelim = []
  for (const g of groups) {
    const timestamps = g.map(b => b.timestamp)
    const span = Math.max(...timestamps) - Math.min(...timestamps)
    const avgConf = g.reduce((s, b) => s + (Number(b.confidence) || 0), 0) / g.length
    // Quality gate: persistence + agreement + confidence (reject isolated noisy frames)
    if (g.length < 2 && avgConf < minConf) continue
    if (span < 0.4 && g.length < 2) continue
    if (avgConf < 0.3) continue
    const counts = {}
    for (const b of g) {
      const key = normalizeText(b.text)
      counts[key] = (counts[key] || 0) + 1
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    const rep = g.find(b => normalizeText(b.text) === best)?.text || best
    prelim.push({
      text: String(rep || '').trim(),
      startSec: Math.max(0, Math.min(...timestamps)),
      endSec: Math.min(dur || Infinity, Math.max(...timestamps) + frameStep),
      confidence: avgConf,
      count: g.length,
    })
  }

  // Merge near-duplicates, enforce ordering/bounds, drop unusable slots
  const merged = []
  for (const seg of prelim) {
    if (!seg.text) continue
    const last = merged[merged.length - 1]
    if (last && textSim(last.text, seg.text) >= TEXT_SIM_THRESHOLD && seg.startSec - last.endSec <= 0.6) {
      last.endSec = Math.min(dur || seg.endSec, Math.max(last.endSec, seg.endSec))
      last.confidence = Math.max(last.confidence, seg.confidence)
      continue
    }
    merged.push(seg)
  }

  return merged
    .filter(s => s.text.trim().length > 0 && s.confidence >= 0.3 && (s.endSec - s.startSec) >= 0.4 && (s.endSec - s.startSec) <= 15)
    .filter(s => !(dur > 0 && (s.startSec >= dur || s.endSec <= 0)))
    .map((s, i) => ({
      id: uuidv4(),
      project_id: undefined,
      index_num: i,
      start_sec: round2(Math.max(0, s.startSec)),
      end_sec: round2(dur > 0 ? Math.min(dur, s.endSec) : s.endSec),
      text: s.text.trim(),
      speaker: null,
      language: null,
    }))
    .filter(s => s.end_sec > s.start_sec)
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

export default dubOcr
