import path from 'path'
import os from 'node:os'
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
// OCR cục bộ (Tesseract) không bị quota API, nên chạy song song theo số CPU.
// OCR_CONCURRENCY cấu hình số frame gửi cùng lúc (provider tự pool worker tương ứng).
const CONCURRENCY = Number(process.env.OCR_CONCURRENCY) || Math.min(os.cpus().length || 1, 4)

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
        ratio_x: 0.1,
        ratio_y: 0.78,
        ratio_w: 0.8,
        ratio_h: 0.12,
        mask_strength: 0.6,
        is_static: 0,
        text: null,
        confidence: null,
        source: 'AUTO',
      }]
      for (const r of fallback) await insert('ocr_regions', r)
      return { regionCount: 1, fallback: true, provider: 'default-band' }
    }
    throw err
  }

  // OCR từng frame (song song CONCURRENCY, local Tesseract không bị quota)
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
    const px = { x: avg(r.samples.map((s) => s.x)), y: avg(r.samples.map((s) => s.y)), width: avg(r.samples.map((s) => s.width)), height: avg(r.samples.map((s) => s.height)) }
    await insert('ocr_regions', {
      id: uuidv4(),
      project_id: project.id,
      start_sec: round2(r.startSec),
      end_sec: round2(r.endSec),
      ...toRatio(px, dims),
      mask_strength: 0.6,
      is_static: 0,
      text: bestText(r.samples),
      confidence: round3(avg(r.samples.map((s) => s.confidence))),
      source: 'AUTO',
    })
  }

  // Fallback vùng mặc định đáy khung hình KHI OCR không phát hiện được box nào
  // nhưng người dùng đã yêu cầu che phụ đề (maskMethod). Đảm bảo "làm mờ tất cả
  // phụ đề" luôn có hiệu lực và phụ đề dịch được đặt đè đúng vị trí chữ gốc —
  // ngay cả khi OCR bỏ sót (provider có cấu hình nhưng trả về 0 box).
  if (!kept.length) {
    let maskMethod = null
    try { maskMethod = (project.params && JSON.parse(project.params).maskMethod) || null } catch (_) {}
    if (maskMethod) {
      await insert('ocr_regions', {
        id: uuidv4(),
        project_id: project.id,
        start_sec: 0,
        end_sec: round2(info.durationSec),
        ratio_x: 0.05,
        ratio_y: 0.80,
        ratio_w: 0.90,
        ratio_h: 0.15,
        mask_strength: 0.6,
        is_static: 0,
        text: null,
        confidence: null,
        source: 'AUTO_DEFAULT',
      })
    }
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
const clamp01 = (n) => { const v = Number(n); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0 }
// pixel box (từ dims) → tỷ lệ (0..1), scale-invariant (docs/02 §2).
const toRatio = (b, dims) => {
  const w = dims.width || 1280
  const h = dims.height || 720
  return {
    ratio_x: round3(clamp01(Number(b.x) / w)),
    ratio_y: round3(clamp01(Number(b.y) / h)),
    ratio_w: round3(clamp01(Number(b.width) / w)),
    ratio_h: round3(clamp01(Number(b.height) / h)),
  }
}

function bestText(samples) {
  const sorted = [...samples].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
  return sorted[0]?.text || null
}

export default dubOcr
