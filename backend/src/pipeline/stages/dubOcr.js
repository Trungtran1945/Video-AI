import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { insert, run } from '../../db/query.js'
import { sampleFrames, probe } from '../../media/mediaService.js'
import { getProvider, ProviderError } from '../../providers/registry.js'
import { tracked } from '../../providers/tracked.js'
import { projectDir, requireSourceFile, round2, round3 } from '../context.js'
import fs from 'node:fs'

const FRAME_FPS = 2
const FRAME_CAP = 600
const IOU_THRESHOLD = 0.7
const MIN_REGION_SEC = 0.5
const CONCURRENCY = 2

// dub.ocr (docs/05 §B.3): frame sampling → OCR hardsub → merge OcrRegion.
export async function dubOcr(ctx) {
  const { project, job, setProgress } = ctx
  const src = requireSourceFile(project.source_video_key, 'Video nguồn')
  const framesDir = path.join(projectDir(project.id), 'frames')

  const info = await probe(src)
  const dims = { width: info.width || 1280, height: info.height || 720 }

  const frames = await sampleFrames(src, framesDir, { fps: FRAME_FPS, cap: FRAME_CAP })
  setProgress(10)

  let ocr
  try {
    ocr = await getProvider(project.user_id, 'ocr')
  } catch (err) {
    if (err instanceof ProviderError || /API key/i.test(err.message)) {
      // Fallback (docs/03 §3): không có key → vùng chữ mặc định 1/3 dưới khung hình,
      // pipeline vẫn hoàn tất việc che/burn-in.
      console.warn('[dubOcr] không có OCR provider — dùng region mặc định đáy khung hình')
      const fallback = [{
        id: uuidv4(),
        project_id: project.id,
        start_sec: 0,
        end_sec: round2(info.durationSec),
        x: Math.round(dims.width * 0.1),
        y: Math.round(dims.height * 0.78),
        width: Math.round(dims.width * 0.8),
        height: Math.round(dims.height * 0.12),
        text: null,
        confidence: null,
        source: 'AUTO',
      }]
      for (const r of fallback) await insert('ocr_regions', r)
      return { regionCount: 1, fallback: true, provider: 'default-band' }
    }
    throw err
  }

  // OCR từng frame (concurrency 2)
  const boxesPerFrame = []
  for (let i = 0; i < frames.length; i += CONCURRENCY) {
    const batch = frames.slice(i, i + CONCURRENCY)
    const results = await Promise.all(batch.map((f) =>
      tracked(
        { projectId: project.id, jobId: job.id, provider: ocr.id, type: 'ocr' },
        () => ocr.provider.detectSubtitle({ imagePath: f.file, width: dims.width, height: dims.height })
      ).then((r) => ({ t: f.t, boxes: r.boxes })).catch(() => ({ t: f.t, boxes: [] }))
    ))
    boxesPerFrame.push(...results)
    setProgress(10 + Math.round(((i + batch.length) / frames.length) * 70))
  }

  // Merge box liên tiếp có IoU > 0.7 thành region timeline (docs/05 §B.3)
  const regions = mergeBoxes(boxesPerFrame)
  const kept = regions.filter((r) => r.endSec - r.startSec >= MIN_REGION_SEC)

  // Giữ MANUAL regions người dùng đã lưu trước đó (không xoá khi re-run)
  await run(`DELETE FROM ocr_regions WHERE project_id = ? AND source != 'MANUAL'`, [project.id])
  for (const r of kept) {
    await insert('ocr_regions', {
      id: uuidv4(),
      project_id: project.id,
      start_sec: round2(r.startSec),
      end_sec: round2(r.endSec),
      x: Math.round(avg(r.samples.map((s) => s.x))),
      y: Math.round(avg(r.samples.map((s) => s.y))),
      width: Math.round(avg(r.samples.map((s) => s.width))),
      height: Math.round(avg(r.samples.map((s) => s.height))),
      text: bestText(r.samples),
      confidence: round3(avg(r.samples.map((s) => s.confidence))),
      source: 'AUTO',
    })
  }

  // Dọn frames sau khi OCR xong
  try { fs.rmSync(framesDir, { recursive: true, force: true }) } catch (_) {}

  return { frameCount: frames.length, regionCount: kept.length, droppedShort: regions.length - kept.length }
}

// Gộp box theo thời gian: cùng vị trí (IoU > ngưỡng) và cách nhau ≤ 1.5 lần
// khoảng lấy frame → cùng một region hiển thị liên tục trên màn hình.
function mergeBoxes(boxesPerFrame) {
  const regions = []
  for (const { t, boxes } of boxesPerFrame) {
    for (const b of boxes) {
      const last = regions[regions.length - 1]
      if (
        last &&
        t - last.endSec <= (1 / FRAME_FPS) * 1.6 &&
        iou(last.samples[last.samples.length - 1], b) > IOU_THRESHOLD
      ) {
        last.endSec = t
        last.samples.push(b)
      } else if (last && t - last.endSec <= (1 / FRAME_FPS) * 1.6 && overlapsAny(last, b)) {
        last.endSec = t
        last.samples.push(b)
      } else {
        regions.push({ startSec: t, endSec: t, samples: [b] })
      }
    }
  }
  return regions
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter === 0) return 0
  const union = a.width * a.height + b.width * b.height - inter
  return inter / union
}

// Box hơi lệch vị trí nhưng vẫn nằm chồng phần lớn → tính là cùng dòng phụ đề.
function overlapsAny(region, box) {
  const recent = region.samples.slice(-3)
  return recent.some((s) => iou(s, box) > 0.35 && lineClose(s, box))
}

function lineClose(a, b) {
  return Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) < Math.max(a.height, b.height)
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + Number(b) || 0, 0) / arr.length : 0)

function bestText(samples) {
  const sorted = [...samples].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
  return sorted[0]?.text || null
}

export default dubOcr
