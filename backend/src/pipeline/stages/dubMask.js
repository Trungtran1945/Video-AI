import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../db/query.js';
import { listProvidersForCapability } from '../../providers/registry.js';
import { callProvider } from '../../lib/callProvider.js';
import { withProviderFailover } from '../../lib/providerFailover.js';
import { classifyProviderError, ERROR_KINDS } from '../../lib/providerErrors.js';
import { extractMaskFrames, probe } from '../../media/mediaService.js';
import { projectDir, ensureDir, requireSourceFile, round3 } from '../context.js';
import { isProjectRunOwned, runProjectOwned } from '../../services/projectAdmission.js';
import { assertTranslateComplete } from './dubTranslate.js';
import { queryOne } from '../../db/query.js';

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Đều khắp video, bỏ 1s đầu/cuối tránh fade. Trả về [t1, t2, ...] giây (round3).
export function planMaskFrames(durationSec, { maxFrames = 8, minGapSec = 5 } = {}) {
  const d = Number(durationSec);
  if (!(d > 2)) return [round3(d / 2)];
  const usable = Math.max(0, d - 2);
  let n = Math.min(maxFrames, Math.max(2, Math.floor(d / minGapSec)));
  n = Math.max(1, Math.min(n, maxFrames));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = 1 + (usable * (i + 0.5)) / n;
    out.push(round3(Math.min(d - 0.5, Math.max(0.5, t))));
  }
  return out;
}

// Giữ box khả nghi là hardsub (pixel): band dưới 60%, loại logo góc + box ôm khung.
export function filterSubtitleBoxes(boxes, { width, height } = {}) {
  const W = Number(width) || 1280;
  const H = Number(height) || 720;
  return (boxes || [])
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 4 && b.height > 4)
    .filter((b) => {
      const cy = b.y + b.height / 2;
      const isCornerLogo = (b.x < W * 0.12 && b.y < H * 0.12)
        || (b.x + b.width > W * 0.88 && b.y < H * 0.12);
      if (isCornerLogo) return false;
      if (cy < H * 0.40) return false;
      if (b.height < H * 0.02 || b.height > H * 0.25) return false;
      if (b.width < W * 0.10) return false;
      if ((b.width * b.height) > W * H * 0.60) return false;
      return true;
    });
}

// Hợp nhất min/max → padding 4% mỗi chiều → clamp 0..1 → ép min-size.
// Trả về { ratioX, ratioY, ratioW, ratioH } hoặc null khi boxes rỗng.
export function unionToStaticRatio(boxes, { width, height, padRatio = 0.04 } = {}) {
  if (!boxes?.length) return null;
  const W = Number(width);
  const H = Number(height);
  if (!(W > 0 && H > 0)) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.width);
    y1 = Math.max(y1, b.y + b.height);
  }
  const padX = W * padRatio;
  const padY = H * padRatio;
  x0 = Math.max(0, x0 - padX);
  y0 = Math.max(0, y0 - padY);
  x1 = Math.min(W, x1 + padX);
  y1 = Math.min(H, y1 + padY);
  // Ép kích thước tối thiểu để che dứt điểm nhiều dòng hardsub.
  const minW = W * 0.30;
  const minH = H * 0.08;
  if (x1 - x0 < minW) {
    const c = (x0 + x1) / 2;
    x0 = Math.max(0, c - minW / 2);
    x1 = Math.min(W, x0 + minW);
  }
  if (y1 - y0 < minH) {
    const c = (y0 + y1) / 2;
    y0 = Math.max(0, c - minH / 2);
    y1 = Math.min(H, y0 + minH);
  }
  return {
    ratioX: round3(x0 / W),
    ratioY: round3(y0 / H),
    ratioW: round3((x1 - x0) / W),
    ratioH: round3((y1 - y0) / H),
  };
}

export function buildStaticMaskRow({ projectId, durationSec, ratio, params, avgConfidence = null }) {
  const type = params?.maskMethod === 'solid' ? 'solid' : 'blur';
  const conf = avgConfidence != null ? Number(avgConfidence) : null;
  return {
    id: uuidv4(),
    project_id: projectId,
    start_sec: 0,
    end_sec: round3(Number(durationSec)),
    ratio_x: ratio.ratioX,
    ratio_y: ratio.ratioY,
    ratio_w: ratio.ratioW,
    ratio_h: ratio.ratioH,
    type,
    blur_radius: 12,
    opacity: 1,
    enabled: 1,
    status: 'APPROVED',
    text: 'AUTO_STATIC',
    confidence: conf != null && Number.isFinite(conf) ? round3(conf) : null,
    source: 'AUTO',
    is_static: 1,
  };
}

function parseParams(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return {}; }
}

/**
 * Stage dub.mask — che chữ gốc tự động, 1 vùng tĩnh suốt video.
 * Chạy sau dub.translate (gate dịch xong) và trước khi burn ASS ở dub.render.
 * Render order mask→ASS giữ nguyên nên phụ đề dịch luôn visible trên lớp che.
 * Fail-soft: không thấy chữ / thiếu vision provider → success skipped, không BLOCK.
 */
export async function dubMask(ctx) {
  const { project, job, setProgress, signal, runToken } = ctx;
  if (signal?.aborted) throw new Error('Cancelled');
  const warnings = [];

  // 1. Gate translate dùng chung assertTranslateComplete (không đếm done<total riêng).
  // Mid-run transcript edit: version bump giữa translate→mask → TRANSCRIPT_CHANGED_RETRY.
  const versionBefore = Number((await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id]).catch(() => null))?.transcript_version ?? 0);
  const rows = await query(
    `SELECT id, text, translation FROM transcript_segments WHERE project_id = ?`,
    [project.id]
  );
  const pool = (rows || []).filter((r) => r.text && String(r.text).trim());
  if (!pool.length) throw new Error('BLOCK_RENDER: NO_SEGMENTS — dub.mask cần transcript từ dub.stt (chưa có segment nào)');
  const translations = new Map();
  for (const r of pool) {
    if (r.translation && String(r.translation).trim()) translations.set(r.id, r.translation);
  }
  try {
    assertTranslateComplete(pool, translations, []);
  } catch (_) {
    throw new Error(`TRANSLATE_NEEDS_REVIEW: dub.mask đợi dịch xong (${translations.size}/${pool.length}) — sửa tay qua PATCH /projects/:id/segments/:segmentId/translation rồi chạy lại từ dub.translate`);
  }

  // 2. Ownership + duration/resolution.
  if (runToken && !(await isProjectRunOwned(project.id, runToken))) {
    const e = new Error('RUN_ABORTED');
    e.code = 'RUN_ABORTED';
    throw e;
  }
  const src = requireSourceFile(project.source_video_key, 'Video nguồn');
  const info = await probe(src);
  const durationSec = round3(info.durationSec || project.target_duration_sec || 0);
  if (!(durationSec > 0)) throw new Error('BLOCK_RENDER: INVALID_DURATION — không đo được duration video nguồn');
  const width = info.width || 1280;
  const height = info.height || 720;
  if (signal?.aborted) throw new Error('Cancelled');
  setProgress(10);

  // 3. Idempotency: xóa AUTO cũ của chính stage này, giữ MANUAL + LEGACY.
  // KHÔNG bump transcript_version (mask là consumer-side như ttsAlign/render).
  const deleted = await runProjectOwned(
    project.id, runToken,
    `DELETE FROM ocr_regions WHERE project_id = ? AND source = 'AUTO'`,
    [project.id]
  );
  if (runToken && !deleted) {
    const e = new Error('RUN_ABORTED');
    e.code = 'RUN_ABORTED';
    throw e;
  }

  // 4. Plan frames + extract thumbnails.
  const params = parseParams(project.params);
  const timestamps = planMaskFrames(durationSec, { maxFrames: 8, minGapSec: 5 });
  const dir = ensureDir(projectDir(project.id));
  const frames = await extractMaskFrames(src, dir, timestamps, { width: 960 });
  setProgress(20);

  // 5. Vision detect từng frame (bounded, fail-soft từng frame).
  const candidates = await listProvidersForCapability(project.user_id, 'vision');
  const langRaw = String(params.sourceLanguage || '').trim().toLowerCase();
  const sourceLanguage = langRaw && langRaw !== 'auto' ? params.sourceLanguage : undefined;
  let model = candidates[0]?.id || null;
  const collected = [];
  let sawNoProvider = false;
  let stopLoop = false;

  if (!candidates.length) {
    sawNoProvider = true;
    warnings.push('no-vision-provider: chưa cấu hình vision provider — bỏ qua che chữ tự động');
  } else {
    for (let fi = 0; fi < frames.length && !stopLoop; fi++) {
      if (signal?.aborted) throw new Error('Cancelled');
      const frame = frames[fi];
      let attempt = 0;
      let frameDone = false;
      while (attempt < 2 && !frameDone && !stopLoop) {
        attempt++;
        try {
          const { result, provider } = await withProviderFailover(
            { capability: 'vision', candidates, maxAttempts: candidates.length },
            (cand) => callProvider({
              provider: cand.id,
              type: 'vision',
              model: cand.provider.model || cand.id,
              input: { imageHash: hashFrameKey(frame), width, height, sourceLanguage: sourceLanguage || null },
              fn: () => cand.provider.detectSubtitle({ imagePath: frame.path, width, height, sourceLanguage }),
              userId: project.user_id,
              apiKeyId: cand.apiKeyId,
              projectId: project.id,
              jobId: job?.id,
            })
          );
          const boxes = Array.isArray(result?.boxes) ? result.boxes : [];
          if (boxes.length) collected.push(...boxes);
          model = result?.model || provider?.id || model;
          frameDone = true;
        } catch (err) {
          if (err?.code === 'NO_PROVIDER_AVAILABLE') {
            sawNoProvider = true;
            warnings.push(`vision frame ${fi + 1}: ${String(err.message || '').slice(0, 160)}`);
            frameDone = true; // bỏ qua frame, không fail stage
            continue;
          }
          let kind = null;
          try { kind = classifyProviderError(err).kind; } catch (_) { kind = null; }
          if (kind === ERROR_KINDS.CONFIGURATION || kind === ERROR_KINDS.PERMANENT) {
            warnings.push(`vision config: dừng detect, giữ ${collected.length} box đã có (${String(err.message || '').slice(0, 120)})`);
            stopLoop = true;
            frameDone = true;
          } else if (kind === ERROR_KINDS.TRANSIENT && attempt < 2) {
            await sleepMs(1000);
          } else {
            // INVALID_RESPONSE / frame hỏng / lỗi khác → bỏ qua frame.
            warnings.push(`vision frame ${fi + 1} bỏ qua: ${String(err.message || '').slice(0, 120)}`);
            frameDone = true;
          }
        }
      }
      if ((fi + 1) % 2 === 0 && signal?.aborted) throw new Error('Cancelled');
      setProgress(20 + Math.round(((fi + 1) / frames.length) * 60));
    }
  }

  // 6. Filter + union 1 bbox tĩnh.
  const kept = filterSubtitleBoxes(collected, { width, height });
  const ratio = unionToStaticRatio(kept, { width, height, padRatio: 0.04 });
  if (!ratio) {
    const reason = sawNoProvider && !collected.length ? 'no-vision-provider' : 'no-text-detected';
    return {
      maskedCount: 0, region: null, framesSampled: frames.length,
      boxesSeen: collected.length, skipped: true, reason, model, warnings,
    };
  }

  // 7-8. Insert 1 row tĩnh + dọn frames tạm.
  const confs = kept.map((b) => Number(b.confidence)).filter((n) => Number.isFinite(n));
  const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;
  const row = buildStaticMaskRow({ projectId: project.id, durationSec, ratio, params, avgConfidence: avgConf });
  try {
    if (runToken && !(await isProjectRunOwned(project.id, runToken))) {
      const e = new Error('RUN_ABORTED');
      e.code = 'RUN_ABORTED';
      throw e;
    }
    const inserted = await runProjectOwned(
      project.id, runToken,
      `INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h,
        type, blur_radius, opacity, enabled, status, text, confidence, source, is_static)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.project_id, row.start_sec, row.end_sec, row.ratio_x, row.ratio_y, row.ratio_w, row.ratio_h,
        row.type, row.blur_radius, row.opacity, row.enabled, row.status, row.text, row.confidence, row.source, row.is_static]
    );
    if (runToken && !inserted) {
      const e = new Error('RUN_ABORTED');
      e.code = 'RUN_ABORTED';
      throw e;
    }
  } finally {
    try { fs.rmSync(path.join(dir, 'mask_frames'), { recursive: true, force: true }); } catch (_) {}
  }
  try { fs.rmSync(path.join(dir, 'mask_frames'), { recursive: true, force: true }); } catch (_) {}
  setProgress(100);
  const versionAfter = Number((await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [project.id]).catch(() => null))?.transcript_version ?? versionBefore);
  if (versionAfter !== versionBefore) {
    throw new Error('TRANSCRIPT_CHANGED_RETRY: transcript đổi giữa lúc dub.mask chạy — chạy lại stage để dùng bản mới nhất');
  }
  return {
    maskedCount: 1,
    region: { ...ratio, start_sec: 0, end_sec: durationSec },
    framesSampled: frames.length,
    boxesSeen: kept.length,
    skipped: false,
    reason: null,
    model,
    warnings,
  };
}

// Khóa cache ổn định cho frame: basename + mtime + size (không đọc bytes,
// không log secret — chỉ dùng làm input_hash cho provider_cache).
function hashFrameKey(frame) {
  try {
    const st = fs.statSync(frame.path);
    return `${path.basename(frame.path)}:${st.size}:${Math.round(st.mtimeMs)}`;
  } catch (_) {
    return `${path.basename(frame.path)}:${frame.atSec}`;
  }
}

export default dubMask;
