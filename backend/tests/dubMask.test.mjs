// dub.mask pure helpers — planMaskFrames / filterSubtitleBoxes / unionToStaticRatio / buildStaticMaskRow
import path from 'node:path';

const mod = await import('../src/pipeline/stages/dubMask.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}
function approx(a, b, eps = 1e-3) { return Math.abs(a - b) <= eps; }

// ── planMaskFrames ──
{
  const ts = mod.planMaskFrames(60);
  assert(Array.isArray(ts) && ts.length === 8, `planMaskFrames(60) → 8 frames (got ${ts?.length})`);
  assert(ts.every((t) => t > 0.5 - 1e-9 && t < 59.5 + 1e-9), 'timestamps trong (0.5,59.5)');
  assert(ts.every((t, i) => i === 0 || t > ts[i - 1]), 'timestamps tăng dần');
}
{
  const ts = mod.planMaskFrames(1.2);
  assert(Array.isArray(ts) && ts.length === 1, `planMaskFrames(1.2) → 1 frame (got ${ts?.length})`);
  assert(ts[0] > 0 && ts[0] < 1.2, 'frame nằm trong video ngắn');
}
{
  const ts = mod.planMaskFrames(10, { maxFrames: 8, minGapSec: 5 });
  assert(ts.length === 2, `planMaskFrames(10) → 2 frames (got ${ts.length})`);
}

// ── filterSubtitleBoxes ──
{
  const W = 1280, H = 720;
  const bottom = { x: 128, y: 518, width: 1024, height: 115, text: 'hardsub', confidence: 0.9 };
  const logoTL = { x: 10, y: 10, width: 120, height: 40, text: 'logo', confidence: 0.9 };
  const logoTR = { x: W - 130, y: 8, width: 120, height: 40, text: 'logo', confidence: 0.9 };
  const topText = { x: 200, y: 50, width: 400, height: 60, text: 'scene sign', confidence: 0.9 };
  const huge = { x: 0, y: 0, width: W, height: H, text: 'fullscreen', confidence: 0.5 };
  const tiny = { x: 600, y: 600, width: 3, height: 3, text: 'dot', confidence: 0.5 };
  const kept = mod.filterSubtitleBoxes([bottom, logoTL, logoTR, topText, huge, tiny], { width: W, height: H });
  assert(kept.some((b) => b.text === 'hardsub'), 'giữ box đáy khung');
  assert(!kept.some((b) => b.text === 'logo'), 'loại logo góc');
  assert(!kept.some((b) => b.text === 'scene sign'), 'loại chữ trên 40% khung');
  assert(!kept.some((b) => b.text === 'fullscreen'), 'loại box ôm cả khung');
  assert(!kept.some((b) => b.text === 'dot'), 'loại box quá nhỏ');
}

// ── unionToStaticRatio ──
{
  const W = 1280, H = 720;
  const boxes = [
    { x: 128, y: 520, width: 500, height: 60 },
    { x: 700, y: 560, width: 400, height: 60 },
  ];
  const r = mod.unionToStaticRatio(boxes, { width: W, height: H, padRatio: 0.04 });
  assert(r && typeof r.ratioX === 'number', 'union trả về ratio');
  // union thô: x0=128,y0=520,x1=1100,y1=620; pad 4% (51.2,28.8) → x0≈76.8,y0≈491.2
  assert(r.ratioX < 128 / W && r.ratioY < 520 / H, 'có padding mở rộng');
  assert(r.ratioW > 0 && r.ratioH >= 0.08 - 1e-9, 'ép chiều cao tối thiểu 8%');
  assert(r.ratioX >= 0 && r.ratioY >= 0 && r.ratioX + r.ratioW <= 1 + 1e-9, 'clamp trong 0..1');
}
{
  assert(mod.unionToStaticRatio([], { width: 1280, height: 720 }) === null, 'union([]) → null');
  // 1 box thấp → vẫn ép min-height 8%
  const r = mod.unionToStaticRatio([{ x: 300, y: 600, width: 600, height: 20 }], { width: 1280, height: 720 });
  assert(r.ratioH >= 0.08 - 1e-9, 'box thấp vẫn đủ cao 8%');
}

// ── buildStaticMaskRow ──
{
  const row = mod.buildStaticMaskRow({
    projectId: 'p1',
    durationSec: 87.32,
    ratio: { ratioX: 0.08, ratioY: 0.7, ratioW: 0.84, ratioH: 0.18 },
    params: { maskMethod: 'blur' },
    avgConfidence: 0.78,
  });
  assert(row.project_id === 'p1', 'row giữ project_id');
  assert(row.start_sec === 0 && approx(row.end_sec, 87.32), 'row tĩnh 0→duration');
  assert(row.source === 'AUTO' && row.status === 'APPROVED' && row.enabled === 1, 'row AUTO/APPROVED/enabled');
  assert(row.type === 'blur', 'maskMethod default → blur');
  assert(row.text === 'AUTO_STATIC', 'text AUTO_STATIC');
  const solid = mod.buildStaticMaskRow({
    projectId: 'p1', durationSec: 10,
    ratio: { ratioX: 0.1, ratioY: 0.7, ratioW: 0.8, ratioH: 0.2 },
    params: { maskMethod: 'solid' }, avgConfidence: 0.5,
  });
  assert(solid.type === 'solid', "maskMethod 'solid' → solid");
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
