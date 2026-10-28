// ZeroTTS supervisor: resolve config / loopback / probe / ensure (dùng fake
// HTTP server node:http, không cần model 900MB, không cần FFmpeg).
// Chạy: node tests/zeroTtsSupervisor.test.mjs
import http from 'node:http';

const {
  resolveZeroTtsSupervisorConfig,
  isLoopbackZeroTtsUrl,
  resolvePythonBin,
  probeZeroTtsHealth,
  waitForZeroTtsReady,
  ensureZeroTtsService,
  stopZeroTtsService,
} = await import('../src/services/zeroTtsSupervisor.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// 1. Prod ép enabled=false dù user set true.
{
  const cfg = resolveZeroTtsSupervisorConfig({ NODE_ENV: 'production', ZEROTTS_ENABLED: 'true' });
  assert(cfg.enabled === false, 'production ép enabled=false');
}

// 2. Default dev: enabled, port 5005, timeout 90s.
{
  const cfg = resolveZeroTtsSupervisorConfig({});
  assert(cfg.enabled === true, 'dev default enabled=true');
  assert(cfg.port === 5005, `default port 5005 (got ${cfg.port})`);
  assert(cfg.startupTimeoutMs === 90000, `default timeout 90s (got ${cfg.startupTimeoutMs})`);
  assert(cfg.autoStart === true && cfg.waitForReady === false, 'default autoStart=true, waitForReady=false');
}

// 3. Loopback detection.
{
  assert(isLoopbackZeroTtsUrl('http://127.0.0.1:5005') === true, '127.0.0.1 là loopback');
  assert(isLoopbackZeroTtsUrl('http://localhost:5005') === true, 'localhost là loopback');
  assert(isLoopbackZeroTtsUrl('http://192.168.1.10:5005') === false, 'IP LAN không phải loopback');
  assert(isLoopbackZeroTtsUrl('http://zerotts:5005') === false, 'hostname docker không phải loopback');
}

// 4. Probe port đóng → econnrefused, không throw.
{
  const r = await probeZeroTtsHealth('http://127.0.0.1:59999', 500);
  assert(r.ok === false && r.reason === 'econnrefused', `port đóng → econnrefused (got ${r.reason})`);
}

// 5. ensure disabled → không spawn gì.
{
  const r = await ensureZeroTtsService({ enabled: false, autoStart: true, baseUrl: 'http://127.0.0.1:59999' });
  assert(r.state === 'disabled' && !r.child, 'disabled → không spawn');
}

// 6. BaseUrl remote + probe fail → unavailable, không spawn.
{
  const r = await ensureZeroTtsService({
    enabled: true,
    autoStart: true,
    baseUrl: 'http://192.168.1.99:9',
    host: '192.168.1.99',
    port: 9,
    startupTimeoutMs: 1000,
    pythonBin: '',
    scriptPath: 'nonexistent.py',
  });
  assert(r.state === 'unavailable' && !r.child, `remote + probe fail → unavailable, không spawn (got ${r.state})`);
  assert(/remote/i.test(r.reason || ''), `reason nhắc remote (got: ${r.reason})`);
}

// 7. Fake server healthy → already-running, không spawn.
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', binary_transport: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const probe = await probeZeroTtsHealth(base, 2000);
  assert(probe.ok === true, 'fake healthy → probe ok');
  const ensured = await ensureZeroTtsService({
    enabled: true, autoStart: true, baseUrl: base, host: '127.0.0.1', port,
    startupTimeoutMs: 2000, pythonBin: '', scriptPath: 'nonexistent.py',
  });
  assert(ensured.state === 'already-running' && !ensured.child, 'đã chạy sẵn → không spawn mới');
  assert(ensured.health?.binary_transport === true, 'already-running trả kèm health để dev kiểm tra transport');
  const waited = await waitForZeroTtsReady(base, 2000);
  assert(waited === true, 'waitForReady true khi đã healthy');
  await new Promise((r) => server.close(r));
}

// 8. Fake server trả 503 MODEL_NOT_READY → probe không ok (chưa ready).
{
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', code: 'MODEL_NOT_READY' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const r = await probeZeroTtsHealth(`http://127.0.0.1:${port}`, 2000);
  assert(r.ok === false, '503 MODEL_NOT_READY → probe không ok');
  assert(r.status === 503, `probe trả status=503 (got ${r.status})`);
  assert(r.code === 'MODEL_NOT_READY', `probe trả code=MODEL_NOT_READY (got ${r.code})`);
  await new Promise((r) => server.close(r));
}

// 9. resolvePythonBin: binary giả → null; python thật → string.
{
  const missing = await resolvePythonBin('python_khong_ton_tai_zzz');
  assert(missing === null, 'binary giả → null');
  const real = await resolvePythonBin('');
  assert(typeof real === 'string' && real.length > 0, `tự dò ra python (${real})`);
}

// 10. isLoopbackZeroTtsUrl IPv6 & malformed edge cases.
{
  assert(isLoopbackZeroTtsUrl('http://[::1]:5005') === true, 'IPv6 [::1] là loopback');
  assert(isLoopbackZeroTtsUrl('') === false, 'URL rỗng → false');
  assert(isLoopbackZeroTtsUrl('not-a-url') === false, 'URL sai định dạng → false');
  assert(isLoopbackZeroTtsUrl('http://0.0.0.0:5005') === false, '0.0.0.0 không phải loopback');
}

// 11. resolveZeroTtsSupervisorConfig edge cases (trailing slashes, invalid port, case-insensitive booleans).
{
  const cfg = resolveZeroTtsSupervisorConfig({
    ZEROTTS_URL: 'http://127.0.0.1:5005///',
    ZEROTTS_PORT: 'invalid-port',
    ZEROTTS_AUTO_START: 'False',
    ZEROTTS_WAIT_FOR_READY: 'True',
    ZEROTTS_STARTUP_TIMEOUT_MS: 'bad-timeout',
  });
  assert(cfg.baseUrl === 'http://127.0.0.1:5005', 'strip trailing slashes');
  assert(cfg.port === 5005, 'invalid port falls back to 5005');
  assert(cfg.autoStart === false, 'case-insensitive autoStart False → false');
  assert(cfg.waitForReady === true, 'case-insensitive waitForReady True → true');
  assert(cfg.startupTimeoutMs === 90000, 'invalid timeout falls back to 90000');
}

// 12. probeZeroTtsHealth: HTML 200, status not 'ok', HTTP 404.
{
  let mode = 'html';
  const server = http.createServer((req, res) => {
    if (mode === 'html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Hello</html>');
    } else if (mode === 'bad-status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting' }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  mode = 'html';
  const rHtml = await probeZeroTtsHealth(base, 2000);
  assert(rHtml.ok === false && rHtml.reason === 'invalid-json', 'HTML response → invalid-json');

  mode = 'bad-status';
  const rBadStatus = await probeZeroTtsHealth(base, 2000);
  assert(rBadStatus.ok === false && rBadStatus.reason === 'invalid-json', 'status khác ok → invalid-json');

  mode = 'not-found';
  const r404 = await probeZeroTtsHealth(base, 2000);
  assert(r404.ok === false && r404.reason === 'http-404', 'HTTP 404 → http-404');

  await new Promise((r) => server.close(r));
}

// 13. ensureZeroTtsService: port occupied by other HTTP server → port-occupied, không spawn.
{
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>Other App</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const r = await ensureZeroTtsService({
    enabled: true, autoStart: true, baseUrl: base, host: '127.0.0.1', port,
    startupTimeoutMs: 2000, pythonBin: '', scriptPath: 'nonexistent.py',
  });
  assert(r.state === 'unavailable' && !r.child, 'port occupied → unavailable, không spawn');
  assert(/port-occupied/i.test(r.reason || ''), `reason nhắc port-occupied (got: ${r.reason})`);

  await new Promise((r) => server.close(r));
}

// 14. ensureZeroTtsService: pythonBin không tồn tại → no-python.
{
  const r = await ensureZeroTtsService({
    enabled: true, autoStart: true, baseUrl: 'http://127.0.0.1:59998', host: '127.0.0.1', port: 59998,
    startupTimeoutMs: 2000, pythonBin: 'python_khong_ton_tai_xyz', scriptPath: 'nonexistent.py',
  });
  assert(r.state === 'unavailable' && !r.child, 'python sai → unavailable');
  assert(/no-python/i.test(r.reason || ''), `reason nhắc no-python (got: ${r.reason})`);
}

// 15. stopZeroTtsService: an toàn với null hoặc child đã thoát.
{
  await stopZeroTtsService(null);
  await stopZeroTtsService(undefined);
  await stopZeroTtsService({ exitCode: 0 });
  assert(true, 'stopZeroTtsService an toàn khi child null/exited');
}

// 16. ensureZeroTtsService: 503 MODEL_NOT_READY rồi 200 → reuse, không spawn con.
{
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    if (calls <= 2) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', code: 'MODEL_NOT_READY' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const r = await ensureZeroTtsService({
    enabled: true, autoStart: true, baseUrl: base, host: '127.0.0.1', port,
    startupTimeoutMs: 5000, pythonBin: '', scriptPath: 'nonexistent.py',
  });
  assert(r.state === 'already-running' && !r.child, '503 loading rồi 200 → already-running, không spawn');
  await new Promise((res) => server.close(res));
}

// 17. ensureZeroTtsService: luôn 503 MODEL_NOT_READY → model-not-ready-timeout, không spawn.
{
  const server = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error', code: 'MODEL_NOT_READY' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const r = await ensureZeroTtsService({
    enabled: true, autoStart: true, baseUrl: base, host: '127.0.0.1', port,
    startupTimeoutMs: 300, pythonBin: '', scriptPath: 'nonexistent.py',
  });
  assert(r.state === 'unavailable' && !r.child, '503 timeout → unavailable, không spawn');
  assert(r.reason === 'model-not-ready-timeout', `reason=model-not-ready-timeout (got ${r.reason})`);
  await new Promise((res) => server.close(res));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
