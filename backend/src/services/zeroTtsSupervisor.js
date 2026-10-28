// ZeroTTS dev supervisor: resolve config, probe /health, spawn Python service,
// wait-ready, graceful stop. Dùng bởi scripts/dev.mjs (npm run dev).
// Mọi hàm fail-soft (không throw ra ngoài trừ lỗi lập trình): API luôn được lên.
import { spawn, spawnSync } from 'node:child_process';

/**
 * @typedef {object} ZeroTtsSupervisorConfig
 * @property {boolean} enabled
 * @property {boolean} autoStart
 * @property {boolean} waitForReady
 * @property {string} baseUrl
 * @property {string} host
 * @property {number} port
 * @property {string} model
 * @property {string} voice
 * @property {number} threads
 * @property {number} concurrency
 * @property {number} startupTimeoutMs
 * @property {string} pythonBin
 * @property {string} scriptPath
 */

/**
 * Pure: dựng config từ env (default param để test không cần process.env thật).
 * Prod ép enabled=false. URL remote (host lạ) → spawnable=false ở caller.
 */
export function resolveZeroTtsSupervisorConfig(env = process.env, opts = {}) {
  const nodeEnv = String(env.NODE_ENV || 'development');
  const host = String(env.ZEROTTS_HOST || '127.0.0.1');
  const port = Number(env.ZEROTTS_PORT || 5005);
  const rawUrl = String(env.ZEROTTS_URL || `http://${host}:${port}`).replace(/\/+$/, '');
  const enabledRaw = env.ZEROTTS_ENABLED;
  const enabled = nodeEnv === 'production'
    ? false
    : (enabledRaw === undefined || enabledRaw === '' ? true : String(enabledRaw).toLowerCase() === 'true');
  return {
    enabled,
    autoStart: String(env.ZEROTTS_AUTO_START ?? 'true').toLowerCase() !== 'false',
    waitForReady: String(env.ZEROTTS_WAIT_FOR_READY ?? 'false').toLowerCase() === 'true',
    baseUrl: rawUrl,
    host,
    port: Number.isInteger(port) && port > 0 ? port : 5005,
    model: env.ZEROTTS_MODEL || env.ZEROTTS_MODEL_DIR || env.ZEROTTS_MODEL_ID || 'zeroweight-ai/ZeroTTS',
    voice: env.ZEROTTS_VOICE || 'maichi',
    threads: Number(env.ZEROTTS_THREADS || 4),
    concurrency: Number(env.ZEROTTS_CONCURRENCY || 1),
    startupTimeoutMs: (() => {
      const n = Number(env.ZEROTTS_STARTUP_TIMEOUT_MS);
      return Number.isFinite(n) && n > 0 ? n : 90000;
    })(),
    pythonBin: String(env.ZEROTTS_PYTHON_BIN || ''),
    scriptPath: opts.scriptPath || '',
  };
}

/**
 * Pure: true khi baseUrl là loopback (được phép spawn local).
 */
export function isLoopbackZeroTtsUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl || ''));
    const host = u.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch (_) {
    return false;
  }
}

/**
 * Dò binary python: preferred (ZEROTTS_PYTHON_BIN) được tôn trọng tuyệt đối —
 * sai thì trả null (báo no-python) thay vì lặng lẽ dùng interpreter khác.
 * Không preferred → thử lần lượt 'python', 'py', 'python3' bằng `bin --version`.
 * Trả về string bin dùng được, hoặc null khi không có python nào.
 */
export async function resolvePythonBin(preferred = '') {
  const candidates = preferred ? [preferred] : ['python', 'py', 'python3'];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 10000, windowsHide: true });
      if (r && r.status === 0) return bin;
    } catch (_) {}
  }
  return null;
}

/**
 * GET baseUrl/health với timeoutMs. Trả về { ok:true, data } | { ok:false, reason }.
 * reason: 'timeout' | 'econnrefused' | 'connect-error' | 'http-xxx' | 'invalid-json'. Không throw.
 * ok chỉ khi HTTP 200 + JSON status:'ok' (503 MODEL_NOT_READY = chưa ready).
 */
export async function probeZeroTtsHealth(baseUrl, timeoutMs = 3000) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(Math.max(100, Number(timeoutMs) || 3000)),
    });
    if (!res.ok) {
      let body = null;
      try { body = await res.json() } catch (_) {}
      return { ok: false, reason: `http-${res.status}`, status: res.status, code: body?.code || null };
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      return { ok: false, reason: 'invalid-json' };
    }
    if (data && data.status === 'ok') return { ok: true, data };
    return { ok: false, reason: 'invalid-json' };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { ok: false, reason: 'timeout' };
    const code = err?.cause?.code || err?.code || '';
    const msg = `${err?.message || ''} ${err?.cause?.message || ''}`;
    if (code === 'ECONNREFUSED' || /econnrefused/i.test(msg)) return { ok: false, reason: 'econnrefused' };
    return { ok: false, reason: 'connect-error' };
  }
}

/**
 * Poll probe đến khi ok hoặc hết timeoutMs (poll 750ms). Trả về true/false. Không throw.
 */
export async function waitForZeroTtsReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    try {
      const r = await probeZeroTtsHealth(baseUrl, 3000);
      if (r.ok) return true;
    } catch (_) {}
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/**
 * Spawn python service (stdio pipe cho stdout/stderr để prefix log, stdin ignore).
 * Trả về ChildProcess. Không đợi ready ở đây.
 */
export function spawnZeroTtsService({ pythonBin, scriptPath, host, port, model, voice, threads, concurrency, extraArgs = [] }) {
  const args = [
    scriptPath,
    '--host', String(host),
    '--port', String(port),
    '--model', String(model),
    '--voice', String(voice),
    '--threads', String(threads),
    '--concurrency', String(concurrency),
    ...extraArgs,
  ];
  return spawn(pythonBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function hadHttpResponse(reason) {
  return typeof reason === 'string' && (reason.startsWith('http-') || reason === 'invalid-json');
}

/**
 * Đảm bảo service: probe trước (đã chạy tay → { state:'already-running' });
 * nếu chưa → resolve python → spawn → wait ready.
 * Luôn resolve (không reject): { state, reason?, child? }.
 * state: 'disabled' | 'already-running' | 'ready' | 'starting-background' | 'unavailable'.
 */
export async function ensureZeroTtsService(config) {
  if (!config.enabled || !config.autoStart) return { state: 'disabled' };
  const first = await probeZeroTtsHealth(config.baseUrl, 2000);
  if (first.ok) return { state: 'already-running', health: first.data || null };
  if (!isLoopbackZeroTtsUrl(config.baseUrl)) {
    return { state: 'unavailable', reason: `ZEROTTS_URL remote (${config.baseUrl}) — bỏ qua auto-start local` };
  }
  // 503 MODEL_NOT_READY = service ZeroTTS đang tải model, không phải port occupied.
  // Chờ trong trần startup rồi reuse; tuyệt đối không spawn thêm process thứ hai.
  if (first.status === 503 && first.code === 'MODEL_NOT_READY') {
    const ready = await waitForZeroTtsReady(config.baseUrl, config.startupTimeoutMs);
    return ready
      ? { state: 'already-running' }
      : { state: 'unavailable', reason: 'model-not-ready-timeout' };
  }
  if (hadHttpResponse(first.reason)) {
    return { state: 'unavailable', reason: `port-occupied (${first.reason}): cổng ${config.port} đã có service khác — đổi ZEROTTS_PORT hoặc tắt service đó` };
  }
  const bin = await resolvePythonBin(config.pythonBin);
  if (!bin) return { state: 'unavailable', reason: 'no-python (cài Python 3.11+ hoặc set ZEROTTS_PYTHON_BIN)' };
  let child;
  try {
    child = spawnZeroTtsService({ ...config, pythonBin: bin });
  } catch (e) {
    return { state: 'unavailable', reason: `spawn-failed: ${String(e?.message || e).slice(0, 160)}` };
  }
  const ready = await waitForZeroTtsReady(config.baseUrl, config.startupTimeoutMs);
  if (ready) return { state: 'ready', child };
  // Hết trần nhưng process còn sống (đang tải model lần đầu) → để nó chạy tiếp nền,
  // API vẫn lên; caller giữ child để kill lúc tắt.
  if (child && child.exitCode === null) return { state: 'starting-background', child, reason: 'timeout-waiting-health' };
  return { state: 'unavailable', reason: 'timeout-waiting-health', child: null };
}

/**
 * Dừng graceful: SIGTERM → đợi stoppedMs (default 5000, Python tự drain) → SIGKILL.
 * Không throw.
 */
export async function stopZeroTtsService(child, stoppedMs = 5000) {
  try {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => {
      try { child.once('exit', () => resolve(true)); } catch (_) { resolve(false); }
    });
    try { child.kill('SIGTERM'); } catch (_) {}
    const done = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), Math.max(0, Number(stoppedMs) || 5000))),
    ]);
    if (!done && child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch (_) {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    }
  } catch (_) {}
}

export default {
  resolveZeroTtsSupervisorConfig,
  isLoopbackZeroTtsUrl,
  resolvePythonBin,
  probeZeroTtsHealth,
  waitForZeroTtsReady,
  spawnZeroTtsService,
  ensureZeroTtsService,
  stopZeroTtsService,
};
