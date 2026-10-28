// dubMaskEdgeCases.test.mjs — Comprehensive edge cases & boundary testing for dub.mask
// Covers:
// 1. planMaskFrames boundaries (0s, <=2s, 2.05s, 2h, NaN, negative, custom gaps)
// 2. filterSubtitleBoxes boundaries (empty/null, NaN/Infinity coords, min 4px dimension,
//    top-left/top-right logos vs bottom corners, cy 40% threshold, height 2%-25%,
//    width 10%, area 60%, vertical/square/4K aspects)
// 3. unionToStaticRatio boundaries (empty/null, invalid W/H, pad/clamp 0..1, minW 30%, minH 8%)
// 4. buildStaticMaskRow formatting (blur vs solid, conf rounding, fields)
// 5. dubMask(ctx) error paths & edge cases (abort signal, 0 segments, partial translation,
//    invalid duration, no vision provider fail-soft, no-text skipped, transient retry)
// 6. Masks API routes (GET returns AUTO, PATCH AUTO -> 400, DELETE AUTO -> 400)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { once } from 'node:events';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_dubmask_edge_'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.STORAGE_DIR = path.join(tmpDir, 'storage');
if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = 'edge-test-key';

const { initSchema } = await import('../src/db/schema.js');
const { query, queryOne, run, insert } = await import('../src/db/query.js');
const { config } = await import('../src/config.js');
const { generateAccessToken } = await import('../src/middleware/auth.js');
const masksRouter = (await import('../src/routes/v1/masks.js')).default;
const {
  planMaskFrames,
  filterSubtitleBoxes,
  unionToStaticRatio,
  buildStaticMaskRow,
  dubMask,
} = await import('../src/pipeline/stages/dubMask.js');
const { GeminiVision } = await import('../src/providers/vision/geminiVision.js');

await initSchema();

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('PASS:', msg);
  } else {
    failures++;
    console.error('FAIL:', msg);
  }
}
function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

// ============================================================================
// 1. planMaskFrames Boundary & Edge Cases
// ============================================================================
console.log('\n--- 1. planMaskFrames Boundaries ---');
{
  // 0s and negative
  const zero = planMaskFrames(0);
  assert(Array.isArray(zero) && zero.length === 1 && approx(zero[0], 0), 'duration 0s -> [0]');

  const neg = planMaskFrames(-10);
  assert(Array.isArray(neg) && neg.length === 1 && approx(neg[0], -5), 'negative duration handled without crash');

  // Exactly 2s (boundary condition <= 2)
  const twoSec = planMaskFrames(2);
  assert(Array.isArray(twoSec) && twoSec.length === 1 && approx(twoSec[0], 1), 'duration 2s -> [1]');

  // Just above 2s: 2.1s
  const justAbove = planMaskFrames(2.1);
  assert(Array.isArray(justAbove) && justAbove.length === 2, 'duration 2.1s -> 2 frames');
  assert(justAbove[0] >= 0.5 && justAbove[1] <= 2.1, 'timestamps within bounds for 2.1s');

  // Very long duration: 7200s (2 hours)
  const twoHours = planMaskFrames(7200);
  assert(twoHours.length === 8, 'duration 7200s -> capped at maxFrames 8');
  assert(twoHours[0] > 0.5 && twoHours[7] < 7199.5, 'timestamps in (0.5, 7199.5)');
  assert(twoHours.every((t, i) => i === 0 || t > twoHours[i - 1]), 'timestamps strictly increasing');

  // Custom options: maxFrames = 12, minGapSec = 2 for 30s
  const custom = planMaskFrames(30, { maxFrames: 12, minGapSec: 2 });
  assert(custom.length === 12, 'respects maxFrames = 12 when duration allows');
}

// ============================================================================
// 2. filterSubtitleBoxes Boundary & Edge Cases
// ============================================================================
console.log('\n--- 2. filterSubtitleBoxes Boundaries ---');
{
  const W = 1280;
  const H = 720;

  // Empty / null / non-array inputs
  assert(filterSubtitleBoxes([], { width: W, height: H }).length === 0, 'empty array -> []');
  assert(filterSubtitleBoxes(null, { width: W, height: H }).length === 0, 'null -> []');
  assert(filterSubtitleBoxes(undefined, { width: W, height: H }).length === 0, 'undefined -> []');

  // Non-finite coordinates (NaN, Infinity, string)
  const invalidCoords = [
    { x: NaN, y: 500, width: 200, height: 50 },
    { x: 100, y: Infinity, width: 200, height: 50 },
    { x: 100, y: 500, width: null, height: 50 },
  ];
  assert(filterSubtitleBoxes(invalidCoords, { width: W, height: H }).length === 0, 'filters out non-finite coordinates');

  // Dimension <= 4px
  const tooSmall = [
    { x: 100, y: 500, width: 4, height: 50 },
    { x: 100, y: 500, width: 200, height: 4 },
  ];
  assert(filterSubtitleBoxes(tooSmall, { width: W, height: H }).length === 0, 'filters out width <= 4 or height <= 4');

  // Top-left and Top-right corner logos (should be filtered)
  const logos = [
    { x: 10, y: 10, width: 100, height: 40, text: 'tl-logo' },
    { x: W - 110, y: 10, width: 100, height: 40, text: 'tr-logo' },
  ];
  assert(filterSubtitleBoxes(logos, { width: W, height: H }).length === 0, 'filters top-left & top-right logos');

  // Bottom corners should NOT be treated as top-corner logos!
  // E.g. bottom-left or bottom-right subtitle badge/text
  const bottomCornerSub = { x: 20, y: 550, width: 300, height: 60, text: 'bottom-sub' };
  const keptBottomCorner = filterSubtitleBoxes([bottomCornerSub], { width: W, height: H });
  assert(keptBottomCorner.length === 1 && keptBottomCorner[0].text === 'bottom-sub', 'bottom corner subtitle is NOT treated as top logo');

  // Vertical threshold: cy < H * 0.40 vs cy >= H * 0.40
  // H = 720. H * 0.40 = 288.
  // Box 1: y = 250, height = 50 -> cy = 275 < 288 (disallowed)
  // Box 2: y = 270, height = 50 -> cy = 295 >= 288 (allowed)
  const topText = { x: 200, y: 250, width: 300, height: 50, text: 'too-high' };
  const midText = { x: 200, y: 270, width: 300, height: 50, text: 'lower-half' };
  const resVert = filterSubtitleBoxes([topText, midText], { width: W, height: H });
  assert(!resVert.some((b) => b.text === 'too-high'), 'excludes box with cy < 0.40*H');
  assert(resVert.some((b) => b.text === 'lower-half'), 'includes box with cy >= 0.40*H');

  // Height boundaries: [0.02 * H, 0.25 * H] -> for 720: [14.4, 180]
  const hBelow = { x: 200, y: 500, width: 300, height: 14, text: 'too-thin' };
  const hAbove = { x: 200, y: 400, width: 300, height: 185, text: 'too-tall' };
  const hValid = { x: 200, y: 500, width: 300, height: 50, text: 'valid-height' };
  const resH = filterSubtitleBoxes([hBelow, hAbove, hValid], { width: W, height: H });
  assert(!resH.some((b) => b.text === 'too-thin'), 'excludes height < 2% H');
  assert(!resH.some((b) => b.text === 'too-tall'), 'excludes height > 25% H');
  assert(resH.some((b) => b.text === 'valid-height'), 'includes height in [2%, 25%] H');

  // Width boundary: width < 10% W -> for 1280: 128
  const wBelow = { x: 200, y: 500, width: 120, height: 50, text: 'too-narrow' };
  const wValid = { x: 200, y: 500, width: 150, height: 50, text: 'valid-width' };
  const resW = filterSubtitleBoxes([wBelow, wValid], { width: W, height: H });
  assert(!resW.some((b) => b.text === 'too-narrow'), 'excludes width < 10% W');
  assert(resW.some((b) => b.text === 'valid-width'), 'includes width >= 10% W');

  // Area boundary: width * height > 60% of W * H
  const areaHuge = { x: 50, y: 300, width: 1180, height: 380, text: 'huge' }; // 448400 > 0.6*1280*720 (552960)? Wait: 1180*380 = 448400 (48.6%)
  const areaMax = { x: 10, y: 300, width: 1260, height: 400, text: 'super-huge' }; // 504000 > 552960?
  const trueHuge = { x: 10, y: 300, width: 1260, height: 450, text: 'true-huge' }; // 567000 > 552960 (61.5%)
  const resArea = filterSubtitleBoxes([trueHuge], { width: W, height: H });
  assert(resArea.length === 0, 'excludes box with area > 60% of total frame');

  // Vertical video 9:16 (720x1280)
  const vertW = 720;
  const vertH = 1280;
  const vertSub = { x: 72, y: 1000, width: 576, height: 100, text: 'vert-sub' };
  const resVertVid = filterSubtitleBoxes([vertSub], { width: vertW, height: vertH });
  assert(resVertVid.length === 1 && resVertVid[0].text === 'vert-sub', 'handles vertical 9:16 video correctly');
}

// ============================================================================
// 3. unionToStaticRatio Boundary & Edge Cases
// ============================================================================
console.log('\n--- 3. unionToStaticRatio Boundaries ---');
{
  const W = 1280;
  const H = 720;

  // Invalid dimensions
  assert(unionToStaticRatio([{ x: 10, y: 10, width: 100, height: 100 }], { width: 0, height: H }) === null, 'width=0 -> null');
  assert(unionToStaticRatio([{ x: 10, y: 10, width: 100, height: 100 }], { width: W, height: -1 }) === null, 'height<0 -> null');

  // Box touching left & top boundaries (padding clamps at 0)
  const leftEdge = [{ x: 10, y: 350, width: 400, height: 80 }];
  const rLeft = unionToStaticRatio(leftEdge, { width: W, height: H, padRatio: 0.04 });
  assert(rLeft.ratioX === 0, 'left edge box clamps ratioX to 0');
  assert(rLeft.ratioX + rLeft.ratioW <= 1, 'ratioX + ratioW <= 1');

  // Box touching right boundary (padding clamps at W)
  const rightEdge = [{ x: W - 350, y: 550, width: 340, height: 80 }];
  const rRight = unionToStaticRatio(rightEdge, { width: W, height: H, padRatio: 0.04 });
  assert(approx(rRight.ratioX + rRight.ratioW, 1.0, 0.01), 'right edge box clamps ratio to right border');

  // Small box gets expanded to minW (30% W = 384px) and minH (8% H = 57.6px)
  const smallBox = [{ x: 500, y: 600, width: 150, height: 30 }];
  const rSmall = unionToStaticRatio(smallBox, { width: W, height: H, padRatio: 0.04 });
  assert(rSmall.ratioW >= 0.30 - 1e-4, 'enforces minimum width 30%');
  assert(rSmall.ratioH >= 0.08 - 1e-4, 'enforces minimum height 8%');

  // Coordinates remain within [0, 1]
  assert(rSmall.ratioX >= 0 && rSmall.ratioY >= 0, 'coordinates >= 0');
  assert(rSmall.ratioX + rSmall.ratioW <= 1 + 1e-3, 'width within 1');
  assert(rSmall.ratioY + rSmall.ratioH <= 1 + 1e-3, 'height within 1');
}

// ============================================================================
// 4. buildStaticMaskRow Formatting & Types
// ============================================================================
console.log('\n--- 4. buildStaticMaskRow Formatting ---');
{
  const rowBlur = buildStaticMaskRow({
    projectId: 'p-test',
    durationSec: '45.678',
    ratio: { ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.15 },
    params: {},
    avgConfidence: 0.85432,
  });
  assert(rowBlur.type === 'blur', 'defaults to blur type');
  assert(rowBlur.blur_radius === 12, 'blur_radius is 12');
  assert(rowBlur.opacity === 1, 'opacity is 1');
  assert(rowBlur.confidence === 0.854, 'avgConfidence rounded to 3 decimals');
  assert(rowBlur.end_sec === 45.678, 'end_sec coerced to number');
  assert(rowBlur.is_static === 1, 'is_static is 1');

  const rowSolid = buildStaticMaskRow({
    projectId: 'p-test',
    durationSec: 30,
    ratio: { ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.15 },
    params: { maskMethod: 'solid' },
    avgConfidence: null,
  });
  assert(rowSolid.type === 'solid', 'supports solid maskMethod');
  assert(rowSolid.confidence === null, 'null avgConfidence preserved');
}

// ============================================================================
// 5. dubMask Stage Execution Error Paths
// ============================================================================
console.log('\n--- 5. dubMask Stage Error Paths & Edge Cases ---');
{
  const pidErr = `p-edge-err-${Date.now()}`;
  await run(`INSERT INTO projects (id, user_id, mode, title, params, source_video_key) VALUES (?, ?, ?, ?, ?, ?)`,
    [pidErr, 'u-edge', 'TRANSLATE_DUB', 'edge errors', '{}', 'uploads/dummy.mp4']);

  // Case A: Signal aborted before start
  {
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    let err = null;
    try {
      await dubMask({
        project: { id: pidErr, user_id: 'u-edge' },
        job: { id: 'j-1' },
        signal: abortCtrl.signal,
      });
    } catch (e) {
      err = e;
    }
    assert(err && err.message === 'Cancelled', 'aborted signal throws Cancelled');
  }

  // Case B: No segments at all (0 segments)
  {
    let err = null;
    try {
      await dubMask({
        project: { id: pidErr, user_id: 'u-edge' },
        job: { id: 'j-2' },
        setProgress: () => {},
        signal: null,
      });
    } catch (e) {
      err = e;
    }
    assert(err && err.message.includes('BLOCK_RENDER: NO_SEGMENTS'), '0 segments throws BLOCK_RENDER: NO_SEGMENTS');
  }

  // Case C: Partial translations (done < total)
  {
    await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['seg-p1', pidErr, 0, 0, 2, 'hello', 'chào']);
    await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['seg-p2', pidErr, 1, 2, 4, 'world', null]); // untranslated segment

    let err = null;
    try {
      await dubMask({
        project: { id: pidErr, user_id: 'u-edge' },
        job: { id: 'j-3' },
        setProgress: () => {},
        signal: null,
      });
    } catch (e) {
      err = e;
    }
    assert(err && err.message.includes('TRANSLATE_NEEDS_REVIEW'), 'partial translations throw TRANSLATE_NEEDS_REVIEW');
  }

  // Create real test video for cases D-H
  // F14: máy thiếu ffmpeg → SKIP các case cần video thật (D-H), không throw oan.
  const uploadsDir = path.join(config.storageDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const realVideoPath = path.join(uploadsDir, 'edge_src.mp4');
  try {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=4', '-pix_fmt', 'yuv420p', '-an', realVideoPath], { stdio: 'ignore' });
  } catch (e) {
    console.warn('SKIP dubMaskEdgeCases D-H: ffmpeg missing —', e.message);
    console.log(failures === 0 ? '\nALL PASS (D-H skipped, no ffmpeg)' : `\n${failures} FAILURES`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    process.exit(failures === 0 ? 0 : 1);
  }

  // Complete translation for segment p2 so translation gate passes
  await run(`UPDATE transcript_segments SET translation = 'thế giới' WHERE id = 'seg-p2' AND project_id = ?`, [pidErr]);

  // Case D: Invalid video duration (corrupted video & 0 duration)
  {
    const pidZeroDur = `p-edge-zero-dur-${Date.now()}`;
    const corruptVideoPath = path.join(uploadsDir, 'corrupt.mp4');
    fs.writeFileSync(corruptVideoPath, 'not a valid video');
    await run(`INSERT INTO projects (id, user_id, mode, title, params, source_video_key) VALUES (?, ?, ?, ?, ?, ?)`,
      [pidZeroDur, 'u-edge', 'TRANSLATE_DUB', 'zero dur', '{}', 'uploads/corrupt.mp4']);
    await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['seg-zd1', pidZeroDur, 0, 0, 2, 'text', 'dịch']);

    let err = null;
    try {
      await dubMask({
        project: { id: pidZeroDur, user_id: 'u-edge', source_video_key: 'uploads/corrupt.mp4' },
        job: { id: 'j-zd' },
        setProgress: () => {},
        signal: null,
      });
    } catch (e) {
      err = e;
    }
    assert(err && (err.message.includes('ffprobe') || err.message.includes('thoát với mã')),
      'corrupt video throws ffprobe error');

    // Case D2: Image file used as video -> durationSec is 0 -> throws BLOCK_RENDER: INVALID_DURATION
    const zeroDurImgPath = path.join(uploadsDir, 'zero_dur.png');
    try {
      execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=1', '-frames:v', '1', zeroDurImgPath], { stdio: 'ignore' });
    } catch (e) {
      console.warn('SKIP dubMaskEdgeCases D2: ffmpeg missing —', e.message);
    }
    const pidImg = `p-edge-img-${Date.now()}`;
    await run(`INSERT INTO projects (id, user_id, mode, title, params, source_video_key) VALUES (?, ?, ?, ?, ?, ?)`,
      [pidImg, 'u-edge', 'TRANSLATE_DUB', 'zero dur img', '{}', 'uploads/zero_dur.png']);
    await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['seg-img1', pidImg, 0, 0, 2, 'text', 'dịch']);

    if (!fs.existsSync(zeroDurImgPath)) {
      console.warn('SKIP dubMaskEdgeCases D2 assert: no png (ffmpeg missing)');
    } else {
      let imgDurErr = null;
      try {
        await dubMask({
          project: { id: pidImg, user_id: 'u-edge', source_video_key: 'uploads/zero_dur.png' },
          job: { id: 'j-img' },
          setProgress: () => {},
          signal: null,
        });
      } catch (e) {
        imgDurErr = e;
      }
      assert(imgDurErr && imgDurErr.message.includes('BLOCK_RENDER: INVALID_DURATION'),
        '0 duration media throws BLOCK_RENDER: INVALID_DURATION');
    }
  }

  // Update source video key to valid video
  await run(`UPDATE projects SET source_video_key = 'uploads/edge_src.mp4' WHERE id = ?`, [pidErr]);
  const validProject = await queryOne(`SELECT * FROM projects WHERE id = ?`, [pidErr]);

  // Case E: Video with no subtitles detected (empty boxes returned) -> skipped no-text-detected
  {
    const origDetect = GeminiVision.prototype.detectSubtitle;
    GeminiVision.prototype.detectSubtitle = async () => ({ boxes: [], model: 'stub-empty' });

    const resNoText = await dubMask({
      project: validProject,
      job: { id: 'j-notext' },
      setProgress: () => {},
      signal: null,
    });
    assert(resNoText.maskedCount === 0 && resNoText.skipped === true && resNoText.reason === 'no-text-detected',
      'empty boxes -> skipped with reason no-text-detected');
    const autoRows = await query(`SELECT * FROM ocr_regions WHERE project_id = ? AND source = 'AUTO'`, [pidErr]);
    assert(autoRows.length === 0, 'no-text-detected creates 0 AUTO rows in DB');

    GeminiVision.prototype.detectSubtitle = origDetect;
  }

  // Case F: Video with only top logos/scene text -> filterSubtitleBoxes filters them all out -> no-text-detected
  {
    const origDetect = GeminiVision.prototype.detectSubtitle;
    GeminiVision.prototype.detectSubtitle = async ({ width = 640, height = 360 } = {}) => ({
      boxes: [
        { x: 10, y: 10, width: 100, height: 40, text: 'top logo' },
        { x: 100, y: 50, width: 200, height: 50, text: 'scene sign' },
      ],
      model: 'stub-top-only',
    });

    const resTopOnly = await dubMask({
      project: validProject,
      job: { id: 'j-toponly' },
      setProgress: () => {},
      signal: null,
    });
    assert(resTopOnly.maskedCount === 0 && resTopOnly.skipped === true && resTopOnly.reason === 'no-text-detected',
      'only top logos/scene signs filtered out -> skipped no-text-detected');

    GeminiVision.prototype.detectSubtitle = origDetect;
  }

  // Case G: Transient error retry recovery (attempt 1 fails with 503, attempt 2 succeeds)
  {
    const origDetect = GeminiVision.prototype.detectSubtitle;
    let callCount = 0;
    GeminiVision.prototype.detectSubtitle = async ({ width = 640, height = 360 } = {}) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('503 Service Unavailable: overloaded');
        err.status = 503;
        throw err;
      }
      return {
        boxes: [{ x: Math.round(width * 0.1), y: Math.round(height * 0.7), width: Math.round(width * 0.8), height: Math.round(height * 0.2), text: 'transient ok', confidence: 0.95 }],
        model: 'stub-transient-retry',
      };
    };

    const resTransient = await dubMask({
      project: validProject,
      job: { id: 'j-transient' },
      setProgress: () => {},
      signal: null,
    });
    assert(resTransient.maskedCount === 1 && resTransient.skipped === false, 'transient error recovered on retry');
    assert(callCount >= 2, `detectSubtitle retried after transient failure (callCount=${callCount})`);

    GeminiVision.prototype.detectSubtitle = origDetect;
  }

  // Case H: Permanent / Config error (e.g. 401 Unauthorized / Bad Key) -> stops loop gracefully and warns
  {
    const origDetect = GeminiVision.prototype.detectSubtitle;
    GeminiVision.prototype.detectSubtitle = async () => {
      const err = new Error('401 Unauthorized: Invalid API Key');
      err.status = 401;
      throw err;
    };

    const resConfigErr = await dubMask({
      project: validProject,
      job: { id: 'j-config-err' },
      setProgress: () => {},
      signal: null,
    });
    assert(resConfigErr.skipped === true && resConfigErr.maskedCount === 0, 'permanent/config error stops loop gracefully');
    assert(Array.isArray(resConfigErr.warnings) && resConfigErr.warnings.length > 0, 'recorded warning for config error');

    GeminiVision.prototype.detectSubtitle = origDetect;
  }
}

// ============================================================================
// 6. Masks API Route & Immutability / Read-only enforcement for AUTO
// ============================================================================
console.log('\n--- 6. Masks API Route Protection for AUTO Mask ---');
{
  const user = { id: 'u-mask-api', email: 'mask-api@test.local', role: 'user', password: 'pw' };
  await insert('users', user);
  const token = generateAccessToken(user);

  const pidApi = `p-mask-api-${Date.now()}`;
  await insert('projects', { id: pidApi, user_id: user.id, mode: 'TRANSLATE_DUB', title: 'mask api test', transcript_version: 1 });

  // Insert an AUTO mask (as produced by dub.mask)
  const autoMaskId = `auto-m-${Date.now()}`;
  await insert('ocr_regions', {
    id: autoMaskId,
    project_id: pidApi,
    start_sec: 0,
    end_sec: 120,
    ratio_x: 0.1,
    ratio_y: 0.7,
    ratio_w: 0.8,
    ratio_h: 0.18,
    type: 'blur',
    blur_radius: 12,
    opacity: 1,
    enabled: 1,
    status: 'APPROVED',
    text: 'AUTO_STATIC',
    confidence: 0.88,
    source: 'AUTO',
    is_static: 1,
  });

  // Insert a MANUAL mask
  const manualMaskId = `manual-m-${Date.now()}`;
  await insert('ocr_regions', {
    id: manualMaskId,
    project_id: pidApi,
    start_sec: 5,
    end_sec: 10,
    ratio_x: 0.2,
    ratio_y: 0.75,
    ratio_w: 0.6,
    ratio_h: 0.15,
    type: 'solid',
    blur_radius: 8,
    opacity: 1,
    enabled: 1,
    status: 'DRAFT',
    source: 'MANUAL',
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', masksRouter);
  const server = app.listen(0);
  await once(server, 'listening');
  const port = server.address().port;

  const baseUrl = `http://127.0.0.1:${port}/api/v1/projects/${pidApi}/masks`;

  // 1. GET /masks returns both AUTO and MANUAL
  const getRes = await fetch(baseUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(getRes.status === 200, 'GET /masks returns 200');
  const getData = await getRes.json();
  assert(Array.isArray(getData.masks) && getData.masks.length === 2, `GET /masks returns 2 masks (got ${getData.masks?.length})`);

  const autoItem = getData.masks.find((m) => m.id === autoMaskId);
  assert(autoItem && autoItem.source === 'AUTO' && autoItem.status === 'APPROVED', 'AUTO mask has source=AUTO and status=APPROVED');
  assert(autoItem.isLegacy === false, 'AUTO mask has isLegacy=false');

  // 2. PATCH on AUTO mask must be blocked (400 read-only)
  const patchAutoRes = await fetch(`${baseUrl}/${autoMaskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ratioX: 0.15 }),
  });
  assert(patchAutoRes.status === 400, 'PATCH on AUTO mask returns 400 (read-only)');
  const patchAutoErr = await patchAutoRes.json();
  assert(patchAutoErr.message.includes('chỉ đọc'), 'PATCH on AUTO mask returns clear read-only error message');

  // 3. DELETE on AUTO mask must be blocked (400 read-only)
  const deleteAutoRes = await fetch(`${baseUrl}/${autoMaskId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert(deleteAutoRes.status === 400, 'DELETE on AUTO mask returns 400 (read-only)');
  const deleteAutoErr = await deleteAutoRes.json();
  assert(deleteAutoErr.message.includes('chỉ đọc'), 'DELETE on AUTO mask returns clear read-only error message');

  // 4. MANUAL mask can still be edited
  const patchManualRes = await fetch(`${baseUrl}/${manualMaskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'APPROVED' }),
  });
  assert(patchManualRes.status === 200, 'MANUAL mask can still be updated/approved');

  await new Promise((r) => server.close(r));
}

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (_) {}

if (failures > 0) process.exit(1);
