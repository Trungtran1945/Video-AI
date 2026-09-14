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

  // Extract frames at 1 FPS (cap at 600 frames)
  const framesDir = path.join(tmp, 'ocr_frames')
  const frames = await sampleFrames(src, framesDir, { fps: 1, cap: 600 })
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

  // Aggregate OCR results into segments
  const segments = aggregateBoxes(allBoxes, durationSec)
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

function aggregateBoxes(allBoxes, durationSec) {
  if (allBoxes.length === 0) return []

  allBoxes.sort((a, b) => a.timestamp - b.timestamp || a.y - b.y)

  const segments = []
  let currentGroup = [allBoxes[0]]

  for (let i = 1; i < allBoxes.length; i++) {
    const prev = allBoxes[i - 1]
    const curr = allBoxes[i]
    const timeDiff = curr.timestamp - prev.timestamp
    const textSimilar = normalizeText(curr.text) === normalizeText(prev.text)

    if (timeDiff <= 2 && textSimilar) {
      currentGroup.push(curr)
    } else {
      segments.push(finalizeGroup(currentGroup))
      currentGroup = [curr]
    }
  }
  segments.push(finalizeGroup(currentGroup))

  const merged = []
  for (const seg of segments) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1]
      if (normalizeText(last.text) === normalizeText(seg.text) && seg.startSec - last.endSec <= 1.5) {
        last.endSec = seg.endSec
        last.confidence = Math.max(last.confidence, seg.confidence)
        continue
      }
    }
    merged.push(seg)
  }

  return merged
    .filter(s => s.text.trim().length > 0 && s.confidence >= 0.3)
    .map((s, i) => ({
      id: uuidv4(),
      project_id: undefined,
      index_num: i,
      start_sec: s.startSec,
      end_sec: s.endSec,
      text: s.text.trim(),
      speaker: null,
      language: null,
    }))
}

function finalizeGroup(group) {
  const textCounts = {}
  for (const box of group) {
    const t = normalizeText(box.text)
    textCounts[t] = (textCounts[t] || 0) + 1
  }
  const bestText = Object.entries(textCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''

  const timestamps = group.map(b => b.timestamp)
  const avgConf = group.reduce((s, b) => s + b.confidence, 0) / group.length

  return {
    text: group.find(b => normalizeText(b.text) === bestText)?.text || bestText,
    startSec: Math.max(0, Math.min(...timestamps)),
    endSec: Math.max(...timestamps) + 1,
    confidence: avgConf,
  }
}

function normalizeText(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch (_) { return {} }
}

export default dubOcr
