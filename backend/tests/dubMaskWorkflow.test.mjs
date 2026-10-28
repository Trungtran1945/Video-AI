// dub.mask workflow: stage ghi đúng 1 row AUTO/APPROVED tĩnh 0→duration;
// manual row không bị xóa; rerun thay thế (không duplicate);
// loadSubtitleRegions đọc được; gate translate; no-text → skipped.
// Chạy: node tests/dubMaskWorkflow.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_dubmask_wf_'));
process.env.DB_PATH = path.join(tmpRoot, 'test.db');
process.env.STORAGE_DIR = path.join(tmpRoot, 'storage');
// Bảo đảm vision candidate tồn tại mà không gọi mạng thật (prototype patch bên dưới).
if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = 'test-dubmask-key';

const { initSchema } = await import('../src/db/schema.js');
const { query, queryOne, run } = await import('../src/db/query.js');
const { config } = await import('../src/config.js');
const { dubMask } = await import('../src/pipeline/stages/dubMask.js');
const { loadSubtitleRegions } = await import('../src/pipeline/stages/dubRender.js');
const { GeminiVision } = await import('../src/providers/vision/geminiVision.js');

await initSchema();

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// Vision stub: box đáy khung theo resolution được yêu cầu (không I/O, không mạng).
const origDetect = GeminiVision.prototype.detectSubtitle;
GeminiVision.prototype.detectSubtitle = async function ({ width = 1280, height = 720 } = {}) {
  const W = Number(width) || 1280;
  const H = Number(height) || 720;
  return {
    boxes: [{ x: Math.round(W * 0.1), y: Math.round(H * 0.72), width: Math.round(W * 0.8), height: Math.round(H * 0.16), text: 'stub hardsub', confidence: 0.8 }],
    model: 'stub',
  };
};

// Video nguồn thật 6s 640x360 (testsrc) để probe + extractMaskFrames chạy thật.
const uploadsDir = path.join(config.storageDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const srcAbs = path.join(uploadsDir, 'src.mp4');
try {
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=6', '-pix_fmt', 'yuv420p', '-an', srcAbs], { stdio: 'ignore' });
} catch (e) {
  // F14: máy thiếu ffmpeg (vd local Windows) → SKIP có evidence, không FAIL oan cả suite.
  console.warn('SKIP dubMaskWorkflow: ffmpeg missing —', e.message);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

const pid = `p-dubmask-wf-${Date.now()}`;
await run(`INSERT INTO projects (id, user_id, mode, title, params, source_video_key, transcript_version) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [pid, 'u-dubmask', 'TRANSLATE_DUB', 'dubmask wf', '{}', 'uploads/src.mp4', 0]);
for (let i = 0; i < 2; i++) {
  await run(`INSERT INTO transcript_segments (id, project_id, index_num, start_sec, end_sec, text, translation) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`seg-${i}`, pid, i, i * 3, i * 3 + 2.5, `source ${i}`, `bản dịch ${i}`]);
}
// 1 manual APPROVED phải được giữ nguyên sau mask.
await run(`INSERT INTO ocr_regions (id, project_id, start_sec, end_sec, ratio_x, ratio_y, ratio_w, ratio_h, source, type, status, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ['m-manual', pid, 0, 6, 0.05, 0.05, 0.2, 0.1, 'MANUAL', 'solid', 'APPROVED', 1]);

const ctxOf = async () => {
  const project = await queryOne('SELECT * FROM projects WHERE id = ?', [pid]);
  return { project, job: { id: `j-${Date.now()}` }, settings: {}, setProgress: () => {}, results: {}, signal: null, runToken: null, transcriptVersionSnapshot: 0, forceTranscript: false };
};

// 1. Chạy mask lần đầu → 1 row AUTO tĩnh.
const r1 = await dubMask(await ctxOf());
assert(r1.maskedCount === 1 && r1.skipped === false, `mask success maskedCount=1 (got ${r1.maskedCount})`);
assert(r1.framesSampled === 2, `6s video → 2 frames (got ${r1.framesSampled})`);
let autos = await query(`SELECT * FROM ocr_regions WHERE project_id = ? AND source = 'AUTO'`, [pid]);
assert(autos.length === 1, `đúng 1 row AUTO (got ${autos.length})`);
assert(autos[0].start_sec === 0, 'AUTO start_sec=0');
assert(Math.abs(Number(autos[0].end_sec) - 6) < 0.6, `AUTO end_sec≈duration (got ${autos[0].end_sec})`);
assert(autos[0].status === 'APPROVED' && Number(autos[0].enabled) === 1, 'AUTO APPROVED+enabled');
assert(autos[0].text === 'AUTO_STATIC', 'AUTO text=AUTO_STATIC');
assert(Number(autos[0].is_static) === 1, 'AUTO is_static=1');
// Vùng che phủ đáy khung (union box stub 10%→90% ngang + padding).
assert(Number(autos[0].ratio_y) > 0.5 && Number(autos[0].ratio_w) >= 0.8, `bbox ở band dưới, đủ rộng (got y=${autos[0].ratio_y} w=${autos[0].ratio_w})`);

// 2. Manual giữ nguyên + transcript_version không bump.
const manual = await queryOne(`SELECT * FROM ocr_regions WHERE id = 'm-manual'`, []);
assert(manual && manual.status === 'APPROVED', 'MANUAL row giữ nguyên');
const pv = await queryOne('SELECT transcript_version FROM projects WHERE id = ?', [pid]);
assert(Number(pv.transcript_version) === 0, `mask KHÔNG bump transcript_version (got ${pv.transcript_version})`);

// 3. Rerun → thay thế, không duplicate.
const r2 = await dubMask(await ctxOf());
assert(r2.maskedCount === 1, 'rerun vẫn maskedCount=1');
autos = await query(`SELECT * FROM ocr_regions WHERE project_id = ? AND source = 'AUTO'`, [pid]);
assert(autos.length === 1, `rerun không duplicate AUTO (got ${autos.length})`);

// 4. loadSubtitleRegions đọc được AUTO mới (+ MANUAL cũ).
{
  const regions = await loadSubtitleRegions(pid, { maskMethod: 'blur' });
  assert(regions.some((r) => r.source === 'AUTO' && r.status === 'APPROVED'), 'loadSubtitleRegions đọc được AUTO/APPROVED');
  assert(regions.some((r) => r.id === 'm-manual'), 'MANUAL vẫn render được');
}

// 5. Gate: translate chưa xong → TRANSLATE_NEEDS_REVIEW, không chạy vision.
{
  await run(`UPDATE transcript_segments SET translation = NULL WHERE id = 'seg-1' AND project_id = ?`, [pid]);
  let msg = '';
  try { await dubMask(await ctxOf()); } catch (e) { msg = e.message; }
  assert(msg.startsWith('TRANSLATE_NEEDS_REVIEW:'), `partial translate → TRANSLATE_NEEDS_REVIEW (got: ${msg.slice(0, 60)})`);
  await run(`UPDATE transcript_segments SET translation = 'bản dịch 1' WHERE id = 'seg-1' AND project_id = ?`, [pid]);
}

// 6. Video không chữ → success skipped, không tạo row.
{
  GeminiVision.prototype.detectSubtitle = async () => ({ boxes: [], model: 'stub-empty' });
  const r = await dubMask(await ctxOf());
  assert(r.maskedCount === 0 && r.skipped === true && r.reason === 'no-text-detected', `no-text → skipped (got reason=${r.reason})`);
  autos = await query(`SELECT * FROM ocr_regions WHERE project_id = ? AND source = 'AUTO'`, [pid]);
  assert(autos.length === 0, 'no-text → không để lại row AUTO');
  GeminiVision.prototype.detectSubtitle = origDetect;
}

GeminiVision.prototype.detectSubtitle = origDetect;
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
