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

  // Pass through user-selected sourceLanguage verbatim (incl. 'auto'); mapping happens in mapLanguage.
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

  // Filter: drop empty text, conf < 0.3 (keep dim CJK for track building).
  const filtered = allBoxes.filter((b) => {
    if (!normalizeText(b?.text)) return false
    const conf = Number(b?.confidence) || 0
    if (conf < 0.3) return false
    if (!Number.isFinite(Number(b?.timestamp))) return false
    return true
  })
  if (!filtered.length) return []
  filtered.sort((a, b) => a.timestamp - b.timestamp || (a.y || 0) - (b.y || 0))

  // Group boxes into frames: same frame if within ±frameStep/2 of frame anchor.
  const frames = []
  for (const b of filtered) {
    const last = frames[frames.length - 1]
    if (!last || Math.abs(Number(b.timestamp) - last.anchor) > frameStep / 2 + 1e-9) {
      frames.push({ anchor: Number(b.timestamp), t: Number(b.timestamp), boxes: [b] })
    } else {
      last.boxes.push(b)
    }
  }
  for (const f of frames) {
    const ts = f.boxes.map((b) => Number(b.timestamp))
    f.t = ts.reduce((s, v) => s + v, 0) / ts.length
  }

  const horizRatio = (a, b) => {
    const ax0 = Number(a?.x) || 0, ax1 = ax0 + (Number(a?.width) || 0)
    const bx0 = Number(b?.x) || 0, bx1 = bx0 + (Number(b?.width) || 0)
    const overlap = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
    const minW = Math.max(1, Math.min(ax1 - ax0, bx1 - bx0))
    return overlap / minW
  }
  const vertRatio = (a, b) => {
    const ah = Number(a?.height), bh = Number(b?.height)
    if (!Number.isFinite(ah) || !Number.isFinite(bh) || ah <= 0 || bh <= 0) return 1
    const ay = Number(a?.y) || 0, by = Number(b?.y) || 0
    const overlap = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
    const minH = Math.max(1, Math.min(ah, bh))
    return overlap / minH
  }
  // Track-based aggregation.
  const tracks = []
  for (const frame of frames) {
    // Cluster frame boxes by y: gap > frameH*0.05 starts a new line.
    const sorted = [...frame.boxes].sort((a, b) => (a.y || 0) - (b.y || 0))
    const clusters = []
    let cur = [sorted[0]]
    for (let i = 1; i < sorted.length; i++) {
      const gap = (sorted[i].y || 0) - (sorted[i - 1].y || 0)
      if (gap > frameH * 0.05) {
        clusters.push(cur)
        cur = [sorted[i]]
      } else {
        cur.push(sorted[i])
      }
    }
    clusters.push(cur)

    // One line-box per y-cluster (merge fragments via union + join).
    const lineBoxes = clusters.map((cl) => {
      if (cl.length === 1) return { ...cl[0], timestamp: frame.t }
      const conf = cl.reduce((s, b) => s + (Number(b.confidence) || 0), 0) / cl.length
      const x0 = Math.min(...cl.map((b) => Number(b.x) || 0))
      const y0 = Math.min(...cl.map((b) => Number(b.y) || 0))
      const x1 = Math.max(...cl.map((b) => (Number(b.x) || 0) + (Number(b.width) || 0)))
      const y1 = Math.max(...cl.map((b) => (Number(b.y) || 0) + (Number(b.height) || 0)))
      return {
        text: cl.map((b) => String(b.text || '').trim()).filter(Boolean).join(' '),
        confidence: conf,
        timestamp: frame.t,
        x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0),
      }
    }).sort((a, b) => (a.y || 0) - (b.y || 0))

    const matched = new Set()
    for (const lb of lineBoxes) {
      const conf = Number(lb.confidence) || 0
      let bestIdx = -1
      let bestScore = -Infinity
      for (let ti = 0; ti < tracks.length; ti++) {
        if (matched.has(ti)) continue
        const tr = tracks[ti]
        const dt = Number(lb.timestamp) - tr.lastSeen
        if (dt < -1e-9 || dt > 1.5 + 1e-9) continue
        if (!bboxCompatible(lb, tr.bbox, frameH)) continue
        if (vertRatio(lb, tr.bbox) <= 0.2) continue
        let sim = 0
        for (const e of tr.textCandidates.values()) {
          sim = Math.max(sim, textSim(lb.text, e.text))
        }
        if (sim < 0.6) continue
        const bboxScore = (Math.min(1, horizRatio(lb, tr.bbox)) + Math.min(1, vertRatio(lb, tr.bbox))) / 2
        const temporalScore = 1 - Math.max(0, dt) / 1.5
        const score = sim * 2 + bboxScore + temporalScore * 0.5
        if (score > bestScore) {
          bestScore = score
          bestIdx = ti
        }
      }
      const key = normalizeText(lb.text)
      if (bestIdx >= 0) {
        const tr = tracks[bestIdx]
        const n = tr.frameCount + 1
        const nx = Number(lb.x), ny = Number(lb.y), nw = Number(lb.width), nh = Number(lb.height)
        if (Number.isFinite(nx)) tr.bbox.x = (tr.bbox.x * tr.frameCount + nx) / n
        if (Number.isFinite(ny)) tr.bbox.y = (tr.bbox.y * tr.frameCount + ny) / n
        if (Number.isFinite(nw)) tr.bbox.width = (tr.bbox.width * tr.frameCount + nw) / n
        if (Number.isFinite(nh)) tr.bbox.height = (tr.bbox.height * tr.frameCount + nh) / n
        tr.lastSeen = Number(lb.timestamp)
        tr.confSum += conf
        tr.frameCount = n
        const e = tr.textCandidates.get(key)
        if (e) {
          e.count += 1
          e.confSum += conf
        } else {
          tr.textCandidates.set(key, { text: String(lb.text), count: 1, confSum: conf })
        }
        matched.add(bestIdx)
      } else {
        tracks.push({
          firstSeen: Number(lb.timestamp),
          lastSeen: Number(lb.timestamp),
          bbox: {
            x: Number(lb.x) || 0,
            y: Number(lb.y) || 0,
            width: Number(lb.width) || 0,
            height: Number(lb.height) || 0,
          },
          textCandidates: new Map([[key, { text: String(lb.text), count: 1, confSum: conf }]]),
          confSum: conf,
          frameCount: 1,
        })
        matched.add(tracks.length - 1)
      }
    }
  }

  // Emit: persistence + confidence gate, representative text by count*avgConf.
  const prelim = []
  for (const tr of tracks) {
    const avgConf = tr.confSum / Math.max(1, tr.frameCount)
    const span = tr.lastSeen - tr.firstSeen
    if (!(tr.frameCount >= 2 || avgConf >= minConf)) continue
    if (span < 0.4) continue
    let best = null
    for (const e of tr.textCandidates.values()) {
      const score = e.count * (e.confSum / e.count)
      if (!best || score > best.score || (score === best.score && e.count > best.count)) {
        best = { score, count: e.count, text: e.text }
      }
    }
    const rep = String(best?.text || '').trim()
    if (!rep) continue
    prelim.push({
      text: rep,
      startSec: Math.max(0, tr.firstSeen),
      endSec: Math.min(dur || Infinity, tr.lastSeen + frameStep),
      confidence: avgConf,
      count: tr.frameCount,
    })
  }
  prelim.sort((a, b) => a.startSec - b.startSec)

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
