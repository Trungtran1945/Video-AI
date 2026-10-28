// Dev orchestrator: `npm run dev` → ZeroTTS kèm API trong 1 terminal.
// Usage: node scripts/dev.mjs [--api-only]
// - ZeroTTS fail-open: lỗi phía Python chỉ warn, API vẫn lên.
// - Prod (`npm start` = node server.js) không bao giờ đi qua file này.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveZeroTtsSupervisorConfig, ensureZeroTtsService, stopZeroTtsService,
} from '../src/services/zeroTtsSupervisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const apiOnly = process.argv.includes('--api-only');

const cfg = resolveZeroTtsSupervisorConfig(process.env, {
  scriptPath: path.join(BACKEND_DIR, 'scripts', 'zerotts_service.py'),
});

// Chỉ nối argv --max-*/--output-root/--shutdown-timeout khi env set tường minh
// (giữ default của Python service trong mọi trường hợp còn lại).
function buildExtraArgs(env) {
  const out = [];
  const pairs = [
    ['ZEROTTS_MAX_INFLIGHT_REQUESTS', '--max-inflight'],
    ['ZEROTTS_MAX_BODY_BYTES', '--max-body-bytes'],
    ['ZEROTTS_MAX_TEXT_CHARS', '--max-text-chars'],
    ['ZEROTTS_OUTPUT_ROOT', '--output-root'],
    ['ZEROTTS_SHUTDOWN_TIMEOUT_MS', '--shutdown-timeout-ms'],
  ];
  for (const [name, flag] of pairs) {
    const v = env[name];
    if (v !== undefined && String(v) !== '') out.push(flag, String(v));
  }
  return out;
}

let pyChild = null;
let ownPyChild = null;
let apiChild = null;
let shuttingDown = false;

function prefixPipe(child, tag) {
  const pipes = [
    [child.stdout, (d) => process.stdout.write(`[${tag}] ${d}`)],
    [child.stderr, (d) => process.stderr.write(`[${tag}] ${d}`)],
  ];
  for (const [stream, fn] of pipes) {
    if (stream) stream.on('data', fn);
  }
}

async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev] ${signal} — stopping api + zerotts...`);
  try { if (apiChild && apiChild.exitCode === null) apiChild.kill('SIGTERM'); } catch (_) {}
  // Chỉ kill process mình spawn (ownPyChild); service chạy tay trước đó (already-running) giữ nguyên.
  if (ownPyChild && ownPyChild.exitCode === null) await stopZeroTtsService(ownPyChild, 5000);
  try { if (apiChild && apiChild.exitCode === null) apiChild.kill('SIGKILL'); } catch (_) {}
  process.exit(code);
}

// 1. ZeroTTS (fail-open: lỗi → warn + chạy API tiếp)
if (!apiOnly) {
  // extraArgs chảy qua config object tới spawnZeroTtsService bên trong ensure()
  // (supervisor chỉ destructure field nó cần — không đổi signature plan).
  const r = await ensureZeroTtsService({ ...cfg, extraArgs: buildExtraArgs(process.env) });
  pyChild = r.child || null;
  if (pyChild) {
    ownPyChild = pyChild;
    prefixPipe(pyChild, 'ZeroTTS');
  }
  if (r.state === 'already-running') {
    console.log(`[dev] ZeroTTS đã chạy sẵn tại ${cfg.baseUrl} — dùng chung, không spawn mới`);
    // Process cũ (trước bản sửa transport) vẫn trả 500 khi synthesize vì
    // save_audio không nhận BytesIO. Cảnh báo thay vì kill process của user.
    if (r.health?.binary_transport !== true) {
      console.warn('[dev] ZeroTTS đang chạy code cũ (thiếu binary_transport) — dừng service đó rồi chạy lại (npm run zerotts:start) để lồng tiếng hoạt động');
    }
  }
  else if (r.state === 'ready') console.log(`[dev] ZeroTTS ready tại ${cfg.baseUrl}`);
  else if (r.state === 'starting-background') console.warn(`[dev] ZeroTTS chưa ready sau ${cfg.startupTimeoutMs}ms (có thể đang tải model lần đầu) — API vẫn lên, TTS sẽ ready sau`);
  else if (r.state === 'disabled') console.log('[dev] ZeroTTS auto-start tắt (ZEROTTS_ENABLED/AUTO_START=false hoặc --api-only)');
  else if (r.reason === 'model-not-ready-timeout') console.warn(`[dev] ZeroTTS chưa sẵn sàng sau ${cfg.startupTimeoutMs}ms (model đang tải) — API vẫn lên; lồng tiếng tự failover, tăng ZEROTTS_STARTUP_TIMEOUT_MS nếu model tải chậm`);
  else console.warn(`[dev] ZeroTTS unavailable (${r.reason}) — API vẫn lên; lồng tiếng tự failover sang edge_tts. Sửa: kiểm tra Python/ZEROTTS_URL hoặc chạy 'npm run zerotts:start'`);
  if (cfg.waitForReady && pyChild && r.state !== 'ready' && r.state !== 'already-running') {
    console.warn('[dev] ZEROTTS_WAIT_FOR_READY=true nhưng TTS chưa ready — vẫn lên API để không kẹt dev (đổi timeout bằng ZEROTTS_STARTUP_TIMEOUT_MS)');
  }
  if (pyChild) {
    pyChild.on('exit', (code) => {
      if (!shuttingDown) console.warn(`[dev] ZeroTTS process thoát (code=${code}) — API vẫn chạy; restart bằng 'npm run zerotts:start' ở terminal riêng nếu cần`);
    });
  }
}

// 2. API (luôn chạy; stdio inherit để giữ log/màu sắc như `node server.js` hôm nay)
apiChild = spawn(process.execPath, ['server.js'], { cwd: BACKEND_DIR, stdio: 'inherit', env: process.env });
apiChild.on('exit', (code) => shutdown('api-exit', code ?? 0));

// 3. Signals (Windows Ctrl+C → SIGINT; docker stop → SIGTERM)
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
