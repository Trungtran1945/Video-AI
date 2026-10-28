// zeroTtsDevOrchestrator.test.mjs — Integration testing for scripts/dev.mjs orchestrator
// Covers:
// - D2: Missing/invalid Python bin -> fail-open (warn no-python, API boots)
// - D3: ZeroTTS already running -> uses existing, does not kill user's process on exit
// - D4: --api-only flag -> skips ZeroTTS, boots API
// - D5: ZEROTTS_ENABLED=false -> skips ZeroTTS, boots API
// - D8: Remote ZEROTTS_URL -> warns remote, does not spawn local, boots API
// - D9: NODE_ENV=production -> auto-start disabled
// Run: node tests/zeroTtsDevOrchestrator.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '..');
const devScript = path.join(BACKEND_DIR, 'scripts', 'dev.mjs');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// Reserve an ephemeral port, then release it: tests must never probe/reuse the
// user's real ZeroTTS on 5005.
function getClosedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function runDevUntilReady(args = [], env = {}, { readyPattern = /Backend running/i, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidai_dev_orch_'));
    const dbPath = path.join(tmpDir, 'test.db');
    const storageDir = path.join(tmpDir, 'storage');

    const mergedEnv = {
      ...process.env,
      DB_PATH: dbPath,
      STORAGE_DIR: storageDir,
      ...env,
    };

    const child = spawn(process.execPath, [devScript, ...args], {
      cwd: BACKEND_DIR,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;

    const cleanup = async () => {
      if (child.exitCode === null) {
        try { child.kill('SIGINT'); } catch (_) {}
        await new Promise((r) => setTimeout(r, 1000));
        if (child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    };

    const getCombined = () => stdout + '\n' + stderr;

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!settled && readyPattern.test(chunk)) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, stdout, stderr, get combined() { return getCombined(); }, cleanup });
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, stdout, stderr, get combined() { return getCombined(); }, cleanup, exitedEarly: true, exitCode: code });
      }
    });

    timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timeout waiting for dev orchestrator. Stdout:\n${stdout}\nStderr:\n${stderr}`));
      }
    }, timeoutMs);
  });
}

// ============================================================================
// 1. D4: --api-only flag -> boots API without ZeroTTS
// ============================================================================
console.log('\n--- 1. Case D4: --api-only ---');
{
  const res = await runDevUntilReady(['--api-only'], { PORT: '3041' });
  assert(!res.exitedEarly, 'API server started in --api-only mode');
  assert(/Backend running/i.test(res.stdout), 'API server listening message printed');
  assert(!res.stdout.includes('[dev] ZeroTTS ready'), 'ZeroTTS not spawned in --api-only mode');
  await res.cleanup();
}

// ============================================================================
// 2. D2: Missing / Invalid Python -> Fail-open (warns no-python, API boots)
// ============================================================================
console.log('\n--- 2. Case D2: Missing Python (Fail-open) ---');
{
  const closedPort = await getClosedPort();
  const res = await runDevUntilReady([], {
    PORT: '3042',
    ZEROTTS_PYTHON_BIN: 'python_khong_ton_tai_xyz',
    ZEROTTS_PORT: String(closedPort),
    ZEROTTS_URL: `http://127.0.0.1:${closedPort}`,
  });
  assert(!res.exitedEarly, 'API server boots even when Python binary is missing (fail-open)');
  assert(res.combined.includes('ZeroTTS unavailable (no-python'), 'Warned no-python in combined output');
  assert(/Backend running/i.test(res.stdout), 'Backend is running on port 3042');
  await res.cleanup();
}

// ============================================================================
// 3. D5: ZEROTTS_ENABLED=false -> skips ZeroTTS, boots API
// ============================================================================
console.log('\n--- 3. Case D5: ZEROTTS_ENABLED=false ---');
{
  const res = await runDevUntilReady([], {
    PORT: '3043',
    ZEROTTS_ENABLED: 'false',
  });
  assert(!res.exitedEarly, 'API server started with ZEROTTS_ENABLED=false');
  assert(res.combined.includes('ZeroTTS auto-start tắt'), 'Logged ZeroTTS auto-start disabled');
  assert(/Backend running/i.test(res.stdout), 'Backend is running on port 3043');
  await res.cleanup();
}

// ============================================================================
// 4. D8: Remote ZEROTTS_URL -> warns remote, does not spawn local, boots API
// ============================================================================
console.log('\n--- 4. Case D8: Remote ZEROTTS_URL ---');
{
  const res = await runDevUntilReady([], {
    PORT: '3044',
    ZEROTTS_URL: 'http://192.168.1.99:5005',
  });
  assert(!res.exitedEarly, 'API server started with remote ZEROTTS_URL');
  assert(res.combined.includes('ZEROTTS_URL remote'), 'Warned remote ZEROTTS_URL skipped local auto-start');
  assert(/Backend running/i.test(res.stdout), 'Backend is running on port 3044');
  await res.cleanup();
}

// ============================================================================
// 5. D3: ZeroTTS already running -> uses existing, does not kill user's process
// ============================================================================
console.log('\n--- 5. Case D3: ZeroTTS already running ---');
{
  // Spin up fake ZeroTTS server on dedicated port
  const fakeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  const ttsPort = fakeServer.address().port;

  const res = await runDevUntilReady([], {
    PORT: '3045',
    ZEROTTS_PORT: String(ttsPort),
    ZEROTTS_URL: `http://127.0.0.1:${ttsPort}`,
  });
  assert(!res.exitedEarly, 'API server started when ZeroTTS already running');
  assert(res.stdout.includes('đã chạy sẵn tại') && res.stdout.includes('dùng chung, không spawn mới'),
    'Logged ZeroTTS already running, reused existing service');
  assert(res.combined.includes('đang chạy code cũ (thiếu binary_transport)'),
    'Cảnh báo service cũ thiếu binary_transport (không kill, chỉ warn)');
  assert(/Backend running/i.test(res.stdout), 'Backend running on port 3045');

  // Clean up dev.mjs
  await res.cleanup();

  // Verify fake ZeroTTS server was NOT killed by dev.mjs exit (ownPyChild check)
  let fakeStillAlive = false;
  try {
    const checkRes = await fetch(`http://127.0.0.1:${ttsPort}/health`);
    const checkData = await checkRes.json();
    fakeStillAlive = checkData?.status === 'ok';
  } catch (_) {}
  assert(fakeStillAlive, 'External ZeroTTS process was preserved after dev.mjs shutdown');

  await new Promise((r) => fakeServer.close(r));
}

// ============================================================================
// 6. D9: NODE_ENV=production -> autoStart is disabled
// ============================================================================
console.log('\n--- 6. Case D9: NODE_ENV=production ---');
{
  // In production, supervisor sets enabled: false -> logs auto-start disabled
  const res = await runDevUntilReady([], {
    NODE_ENV: 'production',
    PORT: '3046',
  }, { readyPattern: /ZeroTTS auto-start tắt|Backend running/i });
  assert(res.stdout.includes('ZeroTTS auto-start tắt'), 'Production disables ZeroTTS auto-start');
  await res.cleanup();
}

// ============================================================================
// 7. D10: Existing ZeroTTS returns 503 MODEL_NOT_READY once, then 200 -> reuse
// ============================================================================
console.log('\n--- 7. Case D10: 503 loading then healthy ---');
{
  let calls = 0;
  const fakeServer = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', code: 'MODEL_NOT_READY' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model_loaded: true }));
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  const ttsPort = fakeServer.address().port;

  const res = await runDevUntilReady([], {
    PORT: '3047',
    ZEROTTS_PORT: String(ttsPort),
    ZEROTTS_URL: `http://127.0.0.1:${ttsPort}`,
    ZEROTTS_STARTUP_TIMEOUT_MS: '5000',
  });
  assert(!res.exitedEarly, 'API server started while ZeroTTS was loading');
  assert(res.stdout.includes('đã chạy sẵn tại'), '503 loading rồi 200 → reused existing service');
  assert(/Backend running/i.test(res.stdout), 'Backend running on port 3047');
  assert(!res.combined.includes('[ZeroTTS]'), 'No Python child spawned while service was loading');
  assert(!res.stdout.includes('ZeroTTS ready tại'), 'No duplicate ZeroTTS start');

  await res.cleanup();
  await new Promise((r) => fakeServer.close(r));
}

console.log(failures === 0 ? '\nALL DEV ORCHESTRATOR TESTS PASS' : `\n${failures} FAILURES IN DEV ORCHESTRATOR TESTS`);
process.exit(failures === 0 ? 0 : 1);
