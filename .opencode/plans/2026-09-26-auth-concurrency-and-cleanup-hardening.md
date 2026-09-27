# Auth Concurrency & Cleanup Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make refresh-token rotation, SSE ticket consume, and password-reset consume atomic under concurrency; move refresh token to HttpOnly cookie with memory-only access token + single-flight refresh; make project creation retry-safe (Idempotency-Key) and deletion cleanup durable/retryable; prove cancel prevents new pipeline stages; add regression tests; update README.

**Architecture:** Leverage the existing single-writer queue (`withWriteLock`/`withTransaction`/`runAffected` in `backend/src/db/query.js`) — every atomic decision becomes ONE conditional SQL statement whose affected-row count decides the winner. Refresh token moves to an HttpOnly cookie (`Path=/api/v1/auth`, `SameSite=Lax`, `Secure` in production); access token lives only in a frontend memory module. Project delete records a `project_cleanup_tasks` row inside the same transaction as the DB wipe (outbox pattern), retried by an in-process interval sweep (Redis-independent, single instance enforced by `INSTANCE_MODE`).

**Tech Stack:** Node ≥18 ESM, Express 4 (built-in `res.cookie`/`clearCookie`, manual cookie parse — no new deps), sql.js, BullMQ/Redis (unchanged), React 18 + Vite, plain-ESM `node --test` for the frontend helper test, project test harness = standalone `backend/tests/*.test.mjs` scripts run by `backend/scripts/run-tests.mjs`.

**Spec:** User task brief in this session (sections 1–8). Decisions confirmed by user:
1. Access token → **memory-only** via `frontend/src/lib/tokenStore.js`; reload → silent cookie refresh.
2. Refresh endpoint → **cookie first, body/header accepted as deprecated fallback** (README documents removal after 2 releases).
3. copyTranscript failure → **202 + project + `transcriptCopyFailed: true`** (post-persist re-read).

## Global Constraints

- NO commits/push/merge (AGENTS.md git rules). Verification only.
- Never break: persistence atomicity (`persistOrRollback`), WRITE_BLOCKED, `isPathInside`/`resolveStorageKey` filesystem security, transcript provenance, upload recovery, Redis worker recovery, SSE design, existing API compat where reasonable.
- Never log/store raw: refresh token, reset token, password, API keys, MASTER_KEY, SSE ticket.
- Never weaken an existing test assertion; never fake CI green. Unrunnable checks → BLOCKED + reason.
- Backend regression gate: `cd backend; npm run lint && npm test` (full suite, all 78 existing files). Frontend: `npm run lint`, `npm run typecheck`, `npm run build` (no `npm test` exists — do not invent one).
- sql.js writes serialize via the write queue; reads are unlocked. All CAS decisions must be single SQL statements executed through `runAffected`/`tx.runAffected`.
- New DB tables use `CREATE TABLE IF NOT EXISTS` in `backend/src/db/schema.js` (auto-migrates existing DBs).

---

### Task 1: Atomic refresh rotation + HttpOnly cookie (backend auth)

**Files:**
- Modify: `backend/src/middleware/auth.js`
- Modify: `backend/src/routes/v1/auth.js`
- Modify: `backend/src/config.js` (add `cookieSecure`)
- Test: `backend/tests/refreshRotationRace.test.mjs` (new)

**Interfaces:**
- Produces: `rotateRefreshToken(userId, oldHash, plainRefresh) → Promise<boolean>` (middleware/auth.js); cookie helpers private to auth.js; responses `{ accessToken, user }` (NO `refreshToken` field) from register/login/refresh.
- Consumes: `runAffected` from `backend/src/db/query.js` (exists, returns `db.getRowsModified()`).

- [ ] **Step 1: Write failing test `backend/tests/refreshRotationRace.test.mjs`**

Follow the exact harness pattern of `backend/tests/passwordReset.test.mjs` (tmp `DB_PATH`/`STORAGE_DIR` via `fs.mkdtempSync`, `NODE_ENV=test`, set env BEFORE any `src/` import, `initSchema()`, bare `express()` app mounting `authRouter` at `/api/v1/auth`, `app.listen(0)`, global `fetch`, `failures` counter, `console.log(failures ? ...) ; process.exit(...)`).

```js
// Cookie helper
const cookieOf = (res) => {
  const raw = res.headers.get('set-cookie') || ''
  const m = raw.match(/refresh_token=([^;]+)/)
  return m ? m[1] : null
}
const postWithCookie = (p, body, cookie) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `refresh_token=${cookie}` } : {}) },
    body: JSON.stringify(body || {}),
  })

// 1) login → 200, HttpOnly cookie present, NO refreshToken in JSON
const loginRes = await post('/login', { email, password })
const loginBody = await loginRes.json()
const loginCookie = cookieOf(loginRes)
assert(loginRes.status === 200 && loginCookie, 'login trả HttpOnly refresh cookie')
assert(loginBody.accessToken && !('refreshToken' in loginBody), 'login JSON không chứa refreshToken raw')
const setCookieHdr = loginRes.headers.get('set-cookie') || ''
assert(/HttpOnly/i.test(setCookieHdr) && /Path=\/api\/v1\/auth/i.test(setCookieHdr) && /SameSite=Lax/i.test(setCookieHdr), 'cookie là HttpOnly + Path=/api/v1/auth + SameSite=Lax')

// 2) 10 concurrent refresh với CÙNG cookie → đúng 1 success
const results = await Promise.all(Array.from({ length: 10 }, () => postWithCookie('/refresh', {}, loginCookie)))
const bodies = await Promise.all(results.map((r) => r.json()))
const oks = results.filter((r) => r.status === 200)
const news = oks.map((r) => cookieOf(r)).filter(Boolean)
assert(oks.length === 1, `10 refresh đồng thời → 1 success (thực tế ${oks.length})`)
assert(results.filter((r) => r.status === 401).length === 9, '9 refresh đồng thời → 401')
assert(news.length === 1 && news[0] !== loginCookie, 'winner nhận cookie mới, không trùng cookie cũ')
assert(!('refreshToken' in bodies.find((b) => b.accessToken)), 'refresh JSON không chứa refreshToken raw')

// 3) cookie cũ đã bị vô hiệu; cookie của winner hoạt động
const oldRes = await postWithCookie('/refresh', {}, loginCookie)
assert(oldRes.status === 401, 'cookie cũ sau rotate → 401 (không phát hành 2 token hợp lệ)')
const winnerRes = await postWithCookie('/refresh', {}, news[0])
assert(winnerRes.status === 200, 'cookie winner rotate tiếp được')

// 4) legacy body input (deprecated) vẫn hoạt động + cũng CAS
const legacyBody = await (await post('/login', { email, password })).json()
const legacyToks = await Promise.all(Array.from({ length: 5 }, () =>
  fetch(`${base}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: legacyBody.refreshToken || legacyBody.accessToken }) })
))
// NOTE: after Task 1 login no longer returns refreshToken — so legacy path is tested
// by storing a known refresh token directly: generate via generateRefreshToken + storeRefreshToken
// (import both from ../../src/middleware/auth.js) then 5 concurrent body refreshes → 1×200, 4×401.
```

Adjust Step-4 block at implementation time to: import `generateRefreshToken, storeRefreshToken` from `../src/middleware/auth.js`, mint user refresh token directly, run 5 concurrent `POST /refresh` with `{ refreshToken }` body → exactly 1×200.

Also add frontend source fences (same file, after backend asserts):

```js
const frontRoot = path.join(__dirname, '..', '..', 'frontend')
const clientSrc = fs.readFileSync(path.join(frontRoot, 'src/api/client.js'), 'utf8')
const authCtxSrc = fs.readFileSync(path.join(frontRoot, 'src/lib/AuthContext.jsx'), 'utf8')
assert(!/localStorage\.(?:set|get|remove)Item\(\s*['"]refresh_token['"]/.test(clientSrc + authCtxSrc), 'frontend không còn chạm localStorage refresh_token')
assert(!/res\.json\(\{[^}]*refreshToken/.test(fs.readFileSync(new URL('../src/routes/v1/auth.js', import.meta.url), 'utf8')), 'auth route không trả refreshToken trong JSON')
```

(Frontend fences will FAIL until Task 4 — expected; the test file must still pass at the END of Task 1 for backend-only parts. Therefore: put frontend fences behind a small `frontExists` guard and add them in Task 4, OR create the test with backend asserts only in Task 1 and append frontend fences in Task 4. **Decision: append frontend fences in Task 4.**)

- [ ] **Step 2: Run test → verify it FAILS**

Run: `cd backend; node tests/refreshRotationRace.test.mjs`
Expected: FAIL (no cookie set today; `refreshToken` still in JSON; concurrent refreshes produce >1 success).

- [ ] **Step 3: Add `cookieSecure` to `backend/src/config.js`**

After the `authDevResetTokenInResponse` entry (~line 123), add to the exported config:

```js
  // Refresh cookie: Secure ở production (RFC: cookie Secure chỉ gửi qua HTTPS;
  // localhost được browser miễn trừ). Ghi đè bằng COOKIE_SECURE=true|false.
  cookieSecure:
    process.env.COOKIE_SECURE !== undefined && process.env.COOKIE_SECURE !== ''
      ? String(process.env.COOKIE_SECURE).toLowerCase() === 'true'
      : nodeEnv === 'production',
```

- [ ] **Step 4: Add CAS rotation to `backend/src/middleware/auth.js`**

Extend import line 3: `import { queryOne, run, runAffected } from '../db/query.js'`. Add after `storeRefreshToken`:

```js
// Atomic compare-and-swap rotation: chỉ rotate khi hash cũ vẫn là hash đang
// lưu VÀ chưa hết hạn. affected===1 → winner; affected===0 → token đã bị
// rotate/invalid bởi request song song → 401. Chạy trong write queue hiện tại.
export async function rotateRefreshToken(userId, oldHash, plainRefresh) {
  const hash = sha256(plainRefresh)
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const affected = await runAffected(
    `UPDATE users SET refresh_token = ?, refresh_expires = ?
     WHERE id = ? AND refresh_token = ? AND refresh_expires > ?`,
    [hash, expires, userId, oldHash, new Date().toISOString()],
    { op: 'auth.refresh.rotate' }
  )
  return affected === 1
}
```

Also **delete the unused `refreshMiddleware` function (lines 117-137) and its `refreshMiddleware` entry in the default export** — it implements the pre-CAS pattern and is referenced nowhere (verified by grep: only its own file). This is orphan cleanup of the exact vulnerable pattern being replaced.

- [ ] **Step 5: Rework `backend/src/routes/v1/auth.js`**

(a) Extend imports:

```js
import { queryOne, insert, updateById, run, withTransaction } from '../../db/query.js'
import {
  generateAccessToken, generateRefreshToken, storeRefreshToken, clearRefreshToken,
  rotateRefreshToken, authMiddleware, extractBearerToken, verifyAccessToken,
} from '../../middleware/auth.js'
import { config } from '../../config.js'
```

(b) Add cookie helpers after `publicUser`:

```js
const REFRESH_COOKIE = 'refresh_token'
const REFRESH_COOKIE_PATH = '/api/v1/auth'

function readRefreshCookie(req) {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== REFRESH_COOKIE) continue
    try { return decodeURIComponent(part.slice(eq + 1).trim()) } catch (_) { return null }
  }
  return null
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: config.cookieSecure, sameSite: 'lax',
    path: REFRESH_COOKIE_PATH, maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: REFRESH_COOKIE_PATH,
  })
}

// Cookie là nguồn chính; body/x-refresh-token là fallback DEPRECATED
// (giữ 2 release cho client không phải trình duyệt — xem README, sẽ bỏ).
function readRefreshToken(req) {
  return readRefreshCookie(req) || req.body?.refreshToken || req.headers['x-refresh-token'] || null
}
```

(c) `register` (line ~40-43) and `login` (line ~61-64): replace response + add cookie:

```js
    const accessToken = generateAccessToken(user)
    const refreshToken = generateRefreshToken(user)
    await storeRefreshToken(user.id, refreshToken)
    setRefreshCookie(res, refreshToken)
    res.json({ accessToken, user: publicUser(user) })
```

(d) Replace the whole `/refresh` handler (lines 71-95):

```js
// POST /api/v1/auth/refresh — atomic CAS rotation (xem rotateRefreshToken).
router.post('/refresh', async (req, res) => {
  try {
    const token = readRefreshToken(req)
    if (!token) return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token required')
    const jwt = (await import('jsonwebtoken')).default
    const { sha256 } = await import('../../lib/crypto.js')
    let decoded
    try {
      decoded = jwt.verify(token, config.jwtRefreshSecret)
    } catch (_) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    const user = await queryOne(`SELECT * FROM users WHERE id = ?`, [decoded.id])
    const oldHash = sha256(token)
    if (!user || user.refresh_token !== oldHash) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    }
    if (user.refresh_expires && new Date(user.refresh_expires) < new Date()) {
      return sendError(res, 401, ERR.AUTH_TOKEN, 'Refresh token expired')
    }
    const accessToken = generateAccessToken(user)
    const newRefresh = generateRefreshToken(user)
    const rotated = await rotateRefreshToken(user.id, oldHash, newRefresh)
    if (!rotated) return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
    setRefreshCookie(res, newRefresh)
    res.json({ accessToken, user: publicUser(user) })
  } catch (err) {
    // DB bận KHÔNG được trả 401 (sẽ logout oan client) → 503 retryable.
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs })
    }
    return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid refresh token')
  }
})
```

(e) Replace `/logout` (lines 97-101) — must work with expired access token (cookie-only logout), otherwise an HttpOnly cookie can never be cleared by the SPA:

```js
// POST /api/v1/auth/logout — không bắt buộc access token còn hạn:
// browser chỉ cần xóa được cookie; xác thực bằng Bearer hoặc chính refresh cookie.
router.post('/logout', async (req, res) => {
  try {
    const cookieToken = readRefreshCookie(req)
    let userId = null
    const bearer = extractBearerToken(req)
    if (bearer) {
      try { userId = verifyAccessToken(bearer).id } catch (_) {}
    }
    if (!userId && cookieToken) {
      const jwt = (await import('jsonwebtoken')).default
      try { userId = jwt.verify(cookieToken, config.jwtRefreshSecret).id } catch (_) {}
    }
    if (userId) await clearRefreshToken(userId)
    clearRefreshCookie(res)
    res.json({ message: 'Logged out' })
  } catch (err) {
    console.error('Logout error:', err)
    clearRefreshCookie(res)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})
```

(f) Replace `/reset-password` body (lines 136-155) with atomic claim — bcrypt BEFORE the transaction only for cost, but the claim + password update must be one transaction (spec 4.3). Preserve distinct error messages for expired vs used (existing test may assert them):

```js
// POST /api/v1/auth/reset-password — one-time atomic consume:
// claim (UPDATE ... used=1 WHERE used=0 AND expires_at>now) quyết định đúng 1
// người thắng; password update trong CÙNG transaction → fail là ROLLBACK (token
// không bị cháy). Đổi mật khẩu đồng thời thu hồi refresh token hiện tại.
router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body
    if (!token || !newPassword) {
      return sendError(res, 400, ERR.VALIDATION, 'Token and new password are required', { field: 'token,newPassword' })
    }
    const { sha256 } = await import('../../lib/crypto.js')
    const tokenHash = sha256(token)
    const hashed = await bcrypt.hash(newPassword, 10)
    try {
      await withTransaction(async (tx) => {
        const claimed = await tx.runAffected(
          `UPDATE reset_tokens SET used = 1 WHERE token = ? AND used = 0 AND expires_at > ?`,
          [tokenHash, new Date().toISOString()],
          { op: 'auth.reset.claim' }
        )
        if (claimed !== 1) {
          // Phân biệt message cho client (read-only, không ảnh hưởng tính nguyên tử)
          const row = await tx.queryOne(`SELECT expires_at FROM reset_tokens WHERE token = ?`, [tokenHash])
          const err = new Error(row ? 'Reset token expired' : 'Invalid or used reset token')
          err.code = 'INVALID_TOKEN'
          throw err
        }
        const row = await tx.queryOne(`SELECT email FROM reset_tokens WHERE token = ?`, [tokenHash])
        const user = row ? await tx.queryOne(`SELECT id FROM users WHERE email = ?`, [row.email]) : null
        if (!user) {
          const err = new Error('Invalid reset token'); err.code = 'INVALID_TOKEN'; throw err
        }
        await tx.run(
          `UPDATE users SET password = ?, refresh_token = NULL, refresh_expires = NULL WHERE id = ?`,
          [hashed, user.id]
        )
      }, { op: 'auth.password.reset' })
    } catch (e) {
      if (e?.code === 'INVALID_TOKEN') return sendError(res, 400, 'INVALID_TOKEN', e.message)
      throw e
    }
    res.json({ message: 'Mật khẩu đã được cập nhật.' })
  } catch (err) {
    console.error('Reset password error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})
```

Note: remove the now-unused `updateById` from the import if nothing else in the file uses it (check first; `register`/`login` use `insert`).

- [ ] **Step 6: Run the race test → expect PASS**

Run: `cd backend; node tests/refreshRotationRace.test.mjs` → expect `ALL PASS`.

- [ ] **Step 7: Run neighbors for regression**

Run: `cd backend; node tests/passwordReset.test.mjs; node tests/postCommitBoundaries.test.mjs; node tests/configProduction.test.mjs; node tests/deploymentInvariant.test.mjs; npm run lint`
Expected: all PASS. If `passwordReset.test.mjs` asserts an exact expiry message, the Step 5(f) distinction already preserves it. If `configProduction`/`deploymentInvariant` snapshot config keys, add `cookieSecure`/`COOKIE_SECURE` to their expectations minimally (additive assertion only — never remove an assertion).

---

### Task 2: Atomic SSE ticket consume

**Files:**
- Modify: `backend/src/middleware/auth.js` (`sseAuthMiddleware`)
- Test: `backend/tests/sseTicketRace.test.mjs` (new)

**Interfaces:**
- Consumes: `runAffected` (Task 1 import already added).
- Produces: invariant — 100 concurrent same-ticket requests → exactly 1 `next()`.

- [ ] **Step 1: Write failing test `backend/tests/sseTicketRace.test.mjs`**

Harness: tmp DB + `initSchema()` + bare express app that mounts the REAL `sseAuthMiddleware` on a probe route (the middleware is the auth boundary; the real SSE route never terminates, making 100-request assertions impractical):

```js
import { sseAuthMiddleware } from '../src/middleware/auth.js'
// ... tmp env, initSchema, insert user + project row + 1 ticket:
//   ticket = crypto.randomBytes(32).toString('hex')
//   INSERT INTO sse_tickets (id, user_id, project_id, ticket_hash, expires_at, used)
//     VALUES (uuid, userId, projectId, sha256(ticket), iso+60s, 0)
const app = express()
app.get('/probe/:id', sseAuthMiddleware, (req, res) => res.json({ ok: true, user: req.user.id }))
const server = app.listen(0)

// 1) 100 concurrent same-ticket → 1 success / 99 reject
const reqs = await Promise.all(Array.from({ length: 100 }, () =>
  fetch(`${base}/probe/${projectId}?ticket=${ticket}`)))
const okCount = reqs.filter((r) => r.status === 200).length
const unauth = reqs.filter((r) => r.status === 401).length
assert(okCount === 1, `100 request cùng ticket → đúng 1 authenticate (thực tế ${okCount})`)
assert(unauth === 99, `99 request bị 401 (thực tế ${unauth})`)

// 2) ticket đã consume → request thứ 101 cũng 401 (single-use)
const again = await fetch(`${base}/probe/${projectId}?ticket=${ticket}`)
assert(again.status === 401, 'ticket reuse sau consume → 401')

// 3) sai project → 403, và không đốt ticket của project đúng
// (insert ticket2, probe với id khác → 403, probe với id đúng → 200)

// 4) expired ticket → 401 + không authenticate
```

Cleanup: close server, delete rows, `fs.rmSync(tmpRoot)`, print `ALL PASS`, `process.exit`.

- [ ] **Step 2: Run → verify FAIL** (`node tests/sseTicketRace.test.mjs` → expect FAIL: today concurrent SELECTs all pass before DELETE).

- [ ] **Step 3: Make the claim atomic in `sseAuthMiddleware`**

In `backend/src/middleware/auth.js`, replace lines 93-96:

```js
      // Single-use: SELECT ở trên chỉ đọc thông tin (user/project/expiry) —
      // QUYẾT ĐỊNH authenticate là DELETE có điều kiện. 100 request đồng thời
      // cùng ticket: write queue serialize → 1 request affected=1, 99 affected=0.
      // Không log ticket.
      const claimed = await runAffected(
        `DELETE FROM sse_tickets WHERE ticket_hash = ?`,
        [sha256(ticket)],
        { op: 'auth.sse.consume' }
      )
      if (claimed !== 1) {
        return sendError(res, 401, ERR.AUTH_TOKEN, 'Invalid or expired ticket')
      }
```

Keep the surrounding comment about single-use/front-end retry. This preserves the `DELETE FROM sse_tickets` source fence asserted by `sseHardening.test.mjs:72`.

- [ ] **Step 4: Run test → PASS**; then run fences: `node tests/sseHardening.test.mjs; node tests/sseConcurrency.test.mjs; node tests/refreshRotationRace.test.mjs` → all PASS.

---

### Task 3: Atomic password-reset consume (regression race)

**Files:**
- Modify: `backend/src/routes/v1/auth.js` (done in Task 1 Step 5f)
- Test: `backend/tests/passwordResetRace.test.mjs` (new)
- Test: extend `backend/tests/passwordReset.test.mjs` (add refresh-revocation assert)

**Interfaces:**
- Produces: invariant — 100 concurrent same-token resets → exactly 1×200, 99×400; `users.refresh_token` cleared.

- [ ] **Step 1: Write `backend/tests/passwordResetRace.test.mjs`**

Harness: copy of `passwordReset.test.mjs` structure with `AUTH_DEV_RESET_TOKEN_IN_RESPONSE=true`. Flow:

```js
// forgot-password → devToken
// Chuẩn bị: user có refresh token hợp lệ (storeRefreshToken từ middleware/auth)
// 100 concurrent POST /reset-password { token: devToken, newPassword }
const results = await Promise.all(Array.from({ length: 100 }, () =>
  post('/reset-password', { token: devToken, newPassword: 'MatKhauMoi_123!' })))
const oks = results.filter((r) => r.status === 200)
const bads = results.filter((r) => r.status === 400)
assert(oks.length === 1, `100 reset đồng thời → 1 success (thực tế ${oks.length})`)
assert(bads.length === 99, `99 reset bị 400 (thực tế ${bads.length})`)

// password đã đổi đúng 1 lần (bcrypt.compare với mật khẩu mới → true)
// token bị consume: reset lần nữa (sequential) → 400
// refresh token bị thu hồi: refresh bằng token cũ → 401
// DB không lưu raw token: row.token === sha256(devToken), không có devToken anywhere in DB bytes
```

- [ ] **Step 2: Run → PASS** (implementation landed in Task 1). If FAIL → re-check Task 1 Step 5f ordering (claim must gate everything).

- [ ] **Step 3: Extend `backend/tests/passwordReset.test.mjs`** with one assert in the existing reset-success block: before reset, call `storeRefreshToken(user.id, someJwt)`; after reset, `SELECT refresh_token FROM users` is NULL. Do not remove/modify existing assertions.

- [ ] **Step 4: Run** `node tests/passwordReset.test.mjs` → PASS.

---

### Task 4: Frontend — tokenStore, HttpOnly cookie flow, single-flight refresh

**Files:**
- Create: `frontend/src/lib/tokenStore.js`
- Create: `frontend/src/api/refreshFlight.js`
- Create: `frontend/src/api/refreshFlight.test.js` (node:test)
- Modify: `frontend/src/api/client.js`
- Modify: `frontend/src/api/auth.js`
- Modify: `frontend/src/lib/AuthContext.jsx`
- Test: append frontend fences to `backend/tests/refreshRotationRace.test.mjs`

**Interfaces:**
- Produces: `setAccessToken(t)`, `getAccessToken()`, `clearAccessToken()`; `createSingleFlight() → run(fn)` with `run.pending()`; `refreshSession() → Promise<{accessToken, user}>` (exported from client.js).
- Consumes: backend cookie flow (Task 1).

- [ ] **Step 1: Write failing test `frontend/src/api/refreshFlight.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSingleFlight } from './refreshFlight.js'

test('10 concurrent calls → fn runs exactly once, all get same result', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 'tok' }
  const results = await Promise.all(Array.from({ length: 10 }, () => run(fn)))
  assert.equal(calls, 1)
  assert.deepEqual(results, Array(10).fill('tok'))
})

test('after settle, next call runs again (inflight cleared)', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fn = async () => { calls++; return calls }
  await run(fn); await run(fn)
  assert.equal(calls, 2)
})

test('rejection propagates to all waiters, then clears', async () => {
  const run = createSingleFlight()
  let calls = 0
  const fail = async () => { calls++; throw new Error('401') }
  const settled = await Promise.allSettled([run(fail), run(fail), run(fail)])
  assert.equal(calls, 1)
  assert.ok(settled.every((s) => s.status === 'rejected'))
  await assert.rejects(run(fail)) // fresh attempt allowed
  assert.equal(calls, 2)
})

test('pending() exposes in-flight state', async () => {
  const run = createSingleFlight()
  assert.equal(run.pending(), false)
  const p = run(() => new Promise((r) => setTimeout(r, 5)))
  assert.equal(run.pending(), true)
  await p
  assert.equal(run.pending(), false)
})
```

- [ ] **Step 2: Run → verify FAIL** (`cd frontend; node --test src/api/refreshFlight.test.js` → module not found).

- [ ] **Step 3: Create `frontend/src/lib/tokenStore.js`**

```js
// Access token chỉ sống trong RAM (memory-only): không bao giờ ghi localStorage,
// XSS không đọc được. Reload trang → AuthContext silent-refresh bằng HttpOnly cookie.
let accessToken = null

export function setAccessToken(token) {
  accessToken = token || null
}

export function getAccessToken() {
  return accessToken
}

export function clearAccessToken() {
  accessToken = null
}
```

- [ ] **Step 4: Create `frontend/src/api/refreshFlight.js`**

```js
// Single-flight: N×401 đồng thời → đúng 1 lời gọi refresh; các lời mời còn
// lại await cùng promise. finally xóa inflight để lần refresh sau hoạt động
// (kể cả khi refresh fail — caller nhận cùng rejection).
export function createSingleFlight() {
  let inflight = null
  const run = (fn) => {
    if (inflight) return inflight
    inflight = Promise.resolve()
      .then(fn)
      .finally(() => { inflight = null })
    return inflight
  }
  run.pending = () => inflight !== null
  return run
}
```

- [ ] **Step 5: Rewrite `frontend/src/api/client.js`**

```js
import axios from 'axios'
import { getAccessToken, setAccessToken, clearAccessToken } from '../lib/tokenStore'
import { createSingleFlight } from './refreshFlight'

const BASE = import.meta.env.VITE_API_BASE || '/api/v1'

export const apiClient = axios.create({
  baseURL: BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // gửi/nhận HttpOnly refresh cookie (cross-origin deploy)
})

apiClient.interceptors.request.use((config) => {
  const token = getAccessToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

const refreshOnce = createSingleFlight()

// Refresh bằng cookie HttpOnly (không còn body refreshToken). Single-flight:
// nhiều 401 đồng thời → 1 POST /auth/refresh. Trả về { accessToken, user }.
export function refreshSession() {
  return refreshOnce(async () => {
    const { data } = await axios.post(`${BASE}/auth/refresh`, null, { withCredentials: true })
    setAccessToken(data.accessToken)
    return data
  })
}

apiClient.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      const hadSession = Boolean(getAccessToken())
      // Khách vãng lai (không token, không refresh đang chạy) → reject như cũ,
      // không gọi refresh vô ích.
      if (hadSession || refreshOnce.pending()) {
        try {
          const data = await refreshSession()
          original.headers.Authorization = `Bearer ${data.accessToken}`
          return apiClient(original) // retry đúng 1 lần (đã _retry) — không loop
        } catch (e) {
          clearAccessToken()
          if (hadSession) window.location.href = '/login'
          return Promise.reject(error)
        }
      }
    }
    return Promise.reject(error)
  }
)
```

- [ ] **Step 6: Update `frontend/src/api/auth.js`**

Replace the `refresh` entry (lines 8-9) — it must no longer accept/pass a raw refresh token:

```js
import api, { refreshSession } from './client'

export const authApi = {
  register: (email, password, name) =>
    api.post('/auth/register', { email, password, name }).then((r) => r.data),
  login: (email, password) =>
    api.post('/auth/login', { email, password }).then((r) => r.data),
  refresh: () => refreshSession(),
  logout: () => api.post('/auth/logout').then((r) => r.data),
  me: () => api.get('/auth/me').then((r) => r.data),
  forgotPassword: (email) =>
    api.post('/auth/forgot-password', { email }).then((r) => r.data),
  resetPassword: (token, newPassword) =>
    api.post('/auth/reset-password', { token, newPassword }).then((r) => r.data),
}
```

- [ ] **Step 7: Update `frontend/src/lib/AuthContext.jsx`**

Add imports: `import { getAccessToken, setAccessToken, clearAccessToken } from './tokenStore'` and `import { refreshSession } from '../api/client'`.

Replace `init` (lines 14-33):

```jsx
  const init = async () => {
    setIsLoadingPublicSettings(false)
    if (getAccessToken()) {
      try {
        const currentUser = await authApi.me()
        setUser(currentUser)
        setIsAuthenticated(true)
      } catch (e) {
        clearAccessToken()
      }
    } else {
      // Reload trang: access token mất (memory-only) → silent refresh bằng
      // HttpOnly cookie. Không có cookie → khách vãng lai, im lặng.
      try {
        const data = await refreshSession()
        setUser(data.user)
        setIsAuthenticated(true)
      } catch (e) { /* anonymous */ }
    }
    setIsLoadingAuth(false)
    setAuthChecked(true)
  }
```

Replace `login` (35-43) and `register` (45-53) body lines — remove both `localStorage.setItem` calls, use `setAccessToken(data.accessToken)`; keep the rest identical. Replace `logout` (55-65): remove `localStorage.removeItem` lines, use `clearAccessToken()`. Replace `refreshAuth` (71-86) localStorage reads with `getAccessToken()`.

Keep `setIsLoadingAuth(false); setAuthChecked(true);` adjacent (no await between) — `ProtectedRoute`'s latent `checkUserAuth` bug stays masked exactly as today (do not touch ProtectedRoute).

- [ ] **Step 8: Run frontend checks**

Run: `cd frontend; node --test src/api/refreshFlight.test.js; npm run lint; npm run typecheck; npm run build`
Expected: all PASS. ESLint does not cover `src/api`/`src/lib` (config scope) — lint passing proves no regression in covered files; `typecheck` covers all of `src` via jsconfig.

- [ ] **Step 9: Append frontend fences to `backend/tests/refreshRotationRace.test.mjs`** (the block from Task 1 Step 1, plus):

```js
assert(/createSingleFlight|refreshOnce/.test(clientSrc), 'client.js dùng single-flight refresh')
assert(!/data\.refreshToken/.test(clientSrc + authCtxSrc), 'frontend không đọc data.refreshToken')
assert(/refreshSession/.test(authCtxSrc), 'AuthContext silent-refresh bằng cookie khi reload')
```

Run: `cd backend; node tests/refreshRotationRace.test.mjs` → PASS.

---

### Task 5: Project creation idempotency + copy-failure 202

**Files:**
- Modify: `backend/src/db/schema.js` (new table)
- Modify: `backend/src/services/projectAdmission.js`
- Modify: `backend/src/routes/v1/projects.js` (POST handler)
- Test: `backend/tests/projectIdempotency.test.mjs` (new)

**Interfaces:**
- Produces: `createProjectWithAdmission(data, options)` gains `options.idempotencyKey`; returns `{ project, admitted, runToken }` OR throws `err.code === 'IDEMPOTENT_REPLAY'` with `err.projectId`.
- Produces: `export const createProjectPostDeps = { copyTranscript, runPipeline }` from `projects.js` (test seam, mirrors `cancelProjectUseCase` deps-injection precedent from commit 79cdb03).
- Produces: header `Idempotency-Key` (1-128 chars, unique per user); copy-failure → `202 {..., transcriptCopyFailed: true}`; error responses include `projectId` when known.

- [ ] **Step 1: Schema — add to `backend/src/db/schema.js` (after the sse_tickets block, ~line 364)**

```js
  // Idempotency-Key cho POST /projects: retry cùng key KHÔNG tạo duplicate.
  // Claim (INSERT OR IGNORE) xảy ra trong CÙNG transaction với project insert.
  db.run(`CREATE TABLE IF NOT EXISTS project_idempotency (
    user_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_date TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, idem_key)
  )`)
```

- [ ] **Step 2: Write failing test `backend/tests/projectIdempotency.test.mjs`**

Harness: tmp DB + express app mounting `projectsRouter` (import from `../src/routes/v1/projects.js`) with `authMiddleware`-issued Bearer token (`generateAccessToken(user)` — copy pattern from `transcriptHttpContract.test.mjs`). **Before importing the router**, patch the seam (module-level export):

```js
const projectsMod = await import('../src/routes/v1/projects.js')
const deps = projectsMod.createProjectPostDeps
const realCopy = deps.copyTranscript
deps.runPipeline = (pid, from, tok) => { pipelineCalls.push(pid); return Promise.resolve() } // never run real stages
```

Test bodies:

```js
const KEY = 'idem-key-001'
const body = { mode: 'SUMMARY', title: 'Idem', sourceVideoKey: 'uploads/x.mp4', copyrightAcknowledged: true }

// A) Sequential retry → 1 project
const r1 = await post('/projects', body, { 'idempotency-key': KEY })
const r2 = await post('/projects', body, { 'idempotency-key': KEY })
assert(r1.status === 202 && r2.status === 202, 'cả 2 lần retry đều 202')
const b1 = await r1.json(), b2 = await r2.json()
assert(b1.id === b2.id, 'retry trả CÙNG project id')
assert(b2.idempotentReplay === true, 'lần retry đánh dấu idempotentReplay')
const rows = await query(`SELECT id FROM projects WHERE user_id = ?`, [user.id])
assert(rows.length === 1, `chỉ 1 project (thực tế ${rows.length})`)

// B) Concurrent same key → 1 project
const KEY2 = 'idem-key-002'
const [c1, c2] = await Promise.all([post('/projects', body, { 'idempotency-key': KEY2 }), post('/projects', body, { 'idempotency-key': KEY2 })])
const statuses = [c1.status, c2.status].sort()
assert(statuses[0] === 202 && statuses[1] === 202, '2 request đồng thời cùng key → cả 2 202')
const cb1 = await c1.json(), cb2 = await c2.json()
assert(cb1.id === cb2.id, 'đồng thời cùng key → cùng project id')
const rows2 = await query(`SELECT id FROM projects WHERE user_id = ?`, [user.id])
assert(rows2.length === 2, `tổng 2 project cho 2 key (thực tế ${rows2.length})`)

// C) copyTranscript failure → 202 + transcriptCopyFailed + project vẫn tồn tại
// Setup: source project completed + video_hash + transcript segments; request
// có videoHash trùng → cache lookup tìm được source → gọi copy giả lỗi:
deps.copyTranscript = async () => { throw new Error('boom') }
const r3 = await post('/projects', { ...body, mode: 'TRANSLATE_DUB', stylePreset: '<slug hợp lệ từ GET /style-presets hoặc seed>', videoHash: 'vh-copy' }, { 'idempotency-key': 'idem-key-003' })
assert(r3.status === 202, 'copy failure vẫn 202')
const b3 = await r3.json()
assert(b3.transcriptCopyFailed === true, 'response đánh dấu transcriptCopyFailed')
const proj3 = await queryOne('SELECT * FROM projects WHERE id = ?', [b3.id])
assert(proj3 && proj3.status === 'queued' && proj3.run_token === null, 'project đã tồn tại, admission released → queued')
assert(String(proj3.recovery_reason || '').includes('cache copy failed'), 'giữ recovery_reason')
assert(pipelineCalls.includes(b3.id) === false, 'không launch pipeline khi copy failed')

// D) Retry cùng key sau copy failure → replay trả project, copy được thử lại (heal)
deps.copyTranscript = realCopy
const r4 = await post('/projects', { ...same TRANSLATE_DUB body }, { 'idempotency-key': 'idem-key-003' })
const b4 = await r4.json()
assert(b4.id === b3.id, 'retry sau copy-failure trả cùng project')

// E) 503 khi DB bận có projectId trong body (armed save failure, như postCommitBoundaries)
//    → dispatch: fs.writeFileSync monkeypatch từ lần save thứ 2 (sau admission),
//    assert body.error.projectId === id project đã tạo, project thực tồn tại 1 bản.

// F) key không hợp lệ → 400 (header > 128 ký tự)
```

Note for C: seed `style_presets` exists (schema seeds system presets? verify at implementation — if empty, insert a preset row directly). Restore `deps.copyTranscript = realCopy` and `deps.runPipeline` in `finally`.

- [ ] **Step 3: Run → verify FAIL** (header ignored today → duplicate projects).

- [ ] **Step 4: Implement admission claim in `backend/src/services/projectAdmission.js`**

Inside `createProjectWithAdmission`, before the existing count/insert (lines 45-57), extend to:

```js
export async function createProjectWithAdmission(data, options = {}) {
  const maxConcurrent = limitFrom(options)
  const idemKey = options.idempotencyKey || null
  return withTransaction(async (tx) => {
    // Idempotency claim: INSERT OR IGNORE cùng transaction với project insert.
    // Request song song cùng key: người thắng commit cả 2; người thua affected=0
    // → rollback (project chưa kịp insert) → IDEMPOTENT_REPLAY.
    if (idemKey) {
      const claimed = await tx.runAffected(
        `INSERT OR IGNORE INTO project_idempotency (user_id, idem_key, project_id) VALUES (?, ?, ?)`,
        [data.userId, idemKey, data.id]
      )
      if (claimed !== 1) {
        const dup = await tx.queryOne(
          `SELECT project_id FROM project_idempotency WHERE user_id = ? AND idem_key = ?`,
          [data.userId, idemKey]
        )
        const err = new Error('Idempotency key already used')
        err.code = 'IDEMPOTENT_REPLAY'
        err.projectId = dup?.project_id || null
        throw err
      }
    }
    const active = await tx.queryOne( /* ...existing unchanged... */ )
    // ...existing count → runToken → tx.insert('projects', ...) unchanged...
    return { project, admitted: Boolean(runToken), runToken }
  }, { op: 'project.admit.create' })
```

(Keep the existing admission logic byte-for-byte; only prepend the claim block and thread `idemKey`.)

- [ ] **Step 5: Implement route changes in `backend/src/routes/v1/projects.js` POST**

(a) Export seam near the imports:

```js
// Test seam (post-commit side effects injectable — cùng pattern deps của
// cancelProjectUseCase). Production không đổi hành vi; test thay bằng fake.
export const createProjectPostDeps = { copyTranscript, runPipeline }
```

(b) Before `router.post('/')`'s `try`, declare: `let createdProjectId = null`.

(c) After validation, parse header:

```js
    let idempotencyKey = null
    const rawKey = req.headers['idempotency-key']
    if (rawKey !== undefined) {
      if (typeof rawKey !== 'string' || !rawKey.trim() || rawKey.length > 128) {
        return sendError(res, 400, ERR.VALIDATION, 'Idempotency-Key must be 1-128 characters', { field: 'Idempotency-Key' })
      }
      idempotencyKey = rawKey.trim()
    }
```

(d) Pass to admission and handle replay:

```js
    const admission = await createProjectWithAdmission({ /* existing data, id: uuidv4() ... */ }, { idempotencyKey })
```
Wait — `data.id` is generated inside the object (`id: uuidv4()`) and the claim uses `data.id`; route object already sets it. Then wrap the call:

```js
    let admission
    try {
      admission = await createProjectWithAdmission({ ...existing object... }, { idempotencyKey })
    } catch (admErr) {
      if (admErr?.code !== 'IDEMPOTENT_REPLAY') throw admErr
      const existing = admErr.projectId ? await queryOne('SELECT * FROM projects WHERE id = ?', [admErr.projectId]) : null
      if (!existing) throw admErr
      return res.status(202).json({ ...existing, params, cachedProjectId: null, idempotentReplay: true })
    }
    const project = admission.project
    createdProjectId = project.id
    const status = project.status
```

(e) Copy block — replace lines 142-155 (no rethrow → 202):

```js
    let transcriptCopyFailed = false
    const copySourceId = cachedProjectId || transcriptOnlySourceId
    if (copySourceId) {
      try {
        await createProjectPostDeps.copyTranscript(copySourceId, project.id, { includeTranslation: Boolean(cachedProjectId) })
      } catch (copyError) {
        // Project ĐÃ tồn tại (commit trước đó) — không 500 để client hiểu nhầm
        // "chưa tạo". Release admission → queued; drainQueued sẽ chạy lại
        // (re-transcribe nếu cache copy lỗi — degraded nhưng đúng).
        transcriptCopyFailed = true
        console.warn(`[Projects] copyTranscript thất bại cho ${project.id}:`, copyError?.message || copyError)
        try {
          await updateProjectOwned(project.id, admission.runToken, {
            status: 'queued', run_token: null, lease_expires_at: null,
            recovery_reason: 'cache copy failed; admission released',
          })
        } catch (releaseErr) {
          console.error(`[Projects] release admission thất bại cho ${project.id}:`, releaseErr?.message || releaseErr)
          throw releaseErr
        }
      }
    }
```

(f) Pipeline launch (line 160-162): use seam + skip when copy failed:

```js
    if (status === 'pending' && !transcriptCopyFailed) {
      createProjectPostDeps.runPipeline(project.id, null, admission.runToken).catch((e) => console.error('[Pipeline] start failed', e))
    }
```

(g) Response (line 164):

```js
    if (transcriptCopyFailed) {
      const fresh = await queryOne('SELECT * FROM projects WHERE id = ?', [project.id])
      return res.status(202).json({ ...(fresh || project), params, cachedProjectId, transcriptCopyFailed: true })
    }
    res.status(202).json({ ...project, params, cachedProjectId })
```

(h) Catch block — include projectId when known:

```js
  } catch (err) {
    const extra = createdProjectId ? { projectId: createdProjectId } : {}
    if (err?.code === 'DB_WRITE_QUEUE_FULL' || err?.code === 'DB_PERSISTENCE_BLOCKED') {
      return sendError(res, 503, err.code, 'Database write queue is busy', { retryAfterMs: err.retryAfterMs, ...extra })
    }
    console.error('Create project error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error', extra)
  }
```

- [ ] **Step 6: DELETE route — add idempotency-row cleanup** (prepares Task 6): in the DELETE `withTransaction` loop of table deletes, add `await tx.run('DELETE FROM project_idempotency WHERE project_id = ?', [req.params.id])`.

- [ ] **Step 7: Run test → PASS**; regression: `node tests/projectAdmission.test.mjs; node tests/concurrencyLimit.test.mjs; node tests/postCommitBoundaries.test.mjs; node tests/dedupeDuplicates.test.mjs; npm run lint`.

---

### Task 6: Durable filesystem cleanup after DELETE

**Files:**
- Modify: `backend/src/db/schema.js` (new table)
- Modify: `backend/src/services/projectCleanup.js`
- Modify: `backend/src/routes/v1/projects.js` (DELETE handler)
- Modify: `backend/server.js` (boot sweep + 60s interval)
- Test: `backend/tests/cleanupDurability.test.mjs` (new)

**Interfaces:**
- Produces: `runCleanupTask(task) → { status, attempts, filesRemoved, filesFailed }`; `sweepProjectCleanupTasks({ limit } = {}) → { processed }`.
- Invariant: task row commits atomically với DB wipe; cleanup failure → task vẫn `pending` → retry có backoff → eventual cleanup; `status='failed'` sau 10 attempts → structured alert log.

- [ ] **Step 1: Schema — add after the `project_idempotency` block**

```js
  // Durable file cleanup sau DELETE project: row này commit CÙNG transaction
  // với DB wipe (outbox) — fs thất bại không bao giờ mất task, chỉ retry.
  db.run(`CREATE TABLE IF NOT EXISTS project_cleanup_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    keys_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_date TEXT DEFAULT (datetime('now')),
    updated_date TEXT
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_due ON project_cleanup_tasks(status, next_attempt_at)`)
```

- [ ] **Step 2: Write failing test `backend/tests/cleanupDurability.test.mjs`**

Harness: tmp DB/STORAGE_DIR, express app mounting `projectsRouter` + Bearer token (copy `postCommitBoundaries.test.mjs` DELETE section — it already has this exact setup). Create a real project with a real file: write `storage/projects/<id>/keep.txt` + a `transcript_segments` row.

```js
// 1) DELETE với fs.unlinkSync bị arm lỗi → response 200 'Deleted'
const origUnlink = fs.unlinkSync
fs.unlinkSync = () => { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e }
const res = await del(`/projects/${id}`)
assert(res.status === 200, 'DB deletion thành công kể cả fs fail')
const task = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE project_id = ?`, [id])
assert(task && task.status === 'pending', 'task cleanup tồn tại, pending sau fs fail')
assert(task.attempts >= 1, 'attempt đã được ghi nhận')
const keys = JSON.parse(task.keys_json)
assert(keys.every((k) => typeof k === 'string' && !k.startsWith('/') && !/^[A-Za-z]:/.test(k)), 'keys là storage key tương đối, không có absolute path')
const proj = await queryOne('SELECT id FROM projects WHERE id = ?', [id])
assert(!proj, 'project row đã xóa')

// 2) Retry có backoff: next_attempt_at nằm trong tương lai
assert(new Date(task.next_attempt_at).getTime() > Date.now(), 'backoff: next_attempt_at tương lai')

// 3) Sweep với task chưa đến hạn → không xử lý; set next_attempt_at = quá khứ
//    + disarm fs → sweep → task done + file biến mất
fs.unlinkSync = origUnlink
await run(`UPDATE project_cleanup_tasks SET next_attempt_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), task.id])
const sweep1 = await sweepProjectCleanupTasks()
assert(sweep1.processed >= 1, 'sweep xử lý task đến hạn')
const done = await queryOne(`SELECT * FROM project_cleanup_tasks WHERE id = ?`, [task.id])
assert(done.status === 'done', 'task done sau retry')
assert(!fs.existsSync(path.join(process.env.STORAGE_DIR, 'projects', id, 'keep.txt')), 'file thực sự biến mất')

// 4) Sweep lần 2 → idempotent (processed không tính task done; không throw)
// 5) Path safety: task với key '../../etc/passwd' → resolveStorageKey trả null (đã bị guard):
//    tạo file ngoài STORAGE_DIR, giao key tương ứng, sweep → file vẫn còn nguyên.
```

- [ ] **Step 3: Run → verify FAIL** (table/task/sweep chưa tồn tại).

- [ ] **Step 4: Implement in `backend/src/services/projectCleanup.js`**

Append (keep existing exports/behavior untouched):

```js
import { query, run } from '../db/query.js'   // extend existing import line 3 (has `query`)

const MAX_CLEANUP_ATTEMPTS = 10

function cleanupBackoffMs(attempts) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000)
}

// Idempotent: file đã gone → existsSync skip; UPDATE khoá `AND status='pending'`
// nên 2 worker song song không thể cùng đánh dấu. Không bao giờ ra ngoài
// storage (deleteProjectFiles giữ nguyên isPathInside/resolveStorageKey guard).
export async function runCleanupTask(task) {
  let keys = []
  try { keys = JSON.parse(task.keys_json || '[]') } catch (_) { keys = [] }
  keys = keys.filter((k) => typeof k === 'string' && k)
  const result = await deleteProjectFiles({ id: task.project_id }, keys)
  const attempts = (Number(task.attempts) || 0) + 1
  const done = result.filesFailed === 0
  const status = done ? 'done' : (attempts >= MAX_CLEANUP_ATTEMPTS ? 'failed' : 'pending')
  const nextAt = new Date(Date.now() + cleanupBackoffMs(attempts)).toISOString()
  await run(
    `UPDATE project_cleanup_tasks
     SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_date = ?
     WHERE id = ? AND status = 'pending'`,
    [status, attempts, done ? null : `filesFailed=${result.filesFailed}`, nextAt, new Date().toISOString(), task.id],
    { op: 'project.cleanup.task' }
  )
  if (status === 'failed') {
    console.error(`[Cleanup] ALERT: project_cleanup_tasks id=${task.id} project=${task.project_id} FAILED sau ${attempts} lần retry — cần can thiệp thủ công`)
  }
  return { status, attempts, ...result }
}

export async function sweepProjectCleanupTasks({ limit = 10 } = {}) {
  const now = new Date().toISOString()
  const due = await query(
    `SELECT * FROM project_cleanup_tasks WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY next_attempt_at LIMIT ?`,
    [now, limit]
  )
  let processed = 0
  for (const task of due) {
    try {
      await runCleanupTask(task)
      processed++
    } catch (e) {
      console.error(`[Cleanup] task ${task.id} retry lỗi:`, e?.message || e)
    }
  }
  return { processed }
}

export default { collectProjectKeys, deleteProjectFiles, runCleanupTask, sweepProjectCleanupTasks }
```

- [ ] **Step 5: Wire DELETE route in `backend/src/routes/v1/projects.js`**

Import `runCleanupTask` alongside `collectProjectKeys, deleteProjectFiles` from `../services/projectCleanup.js`. In the DELETE handler, after collecting `fileKeys` (line 355), insert the task INSIDE the existing `withTransaction` (after `DELETE FROM projects`, before commit):

```js
      await tx.run('DELETE FROM projects WHERE id = ?', [req.params.id])
      await tx.run('DELETE FROM project_idempotency WHERE project_id = ?', [req.params.id])
      // Outbox: cleanup task commit nguyên tử với DB wipe — fs fail không mất task.
      cleanupTaskId = uuidv4()
      await tx.run(
        `INSERT INTO project_cleanup_tasks (id, project_id, keys_json, status, attempts, next_attempt_at)
         VALUES (?, ?, ?, 'pending', 0, ?)`,
        [cleanupTaskId, req.params.id, JSON.stringify([...fileKeys]), new Date().toISOString()]
      )
```

Declare `let cleanupTaskId = null` before the transaction. Replace the post-commit cleanup block (lines 372-383) with:

```js
    // Post-commit fast path: thử dọn ngay; thất bại thì task pending sẽ được
    // sweep retry (server.js interval 60s) — không bao giờ mất, không rollback DB.
    try {
      const outcome = await runCleanupTask({ id: cleanupTaskId, project_id: req.params.id, keys_json: JSON.stringify([...fileKeys]), attempts: 0 })
      if (outcome.status !== 'done') {
        console.warn(`[Projects] xoá ${req.params.id}: cleanup chưa hoàn tất (${outcome.status}) — sẽ retry`)
      }
    } catch (cleanupErr) {
      console.error(`[Projects] cleanup ${req.params.id} post-commit lỗi (sẽ retry):`, cleanupErr?.message || cleanupErr)
    }
```

Check `uuidv4` is already imported in projects.js (it is — used at line 81).

- [ ] **Step 6: Wire retry driver in `backend/server.js`**

Add static import: `import { sweepProjectCleanupTasks } from './src/services/projectCleanup.js'`. In `start()`, after the stale-project recovery block (~line 111), add:

```js
  // Durable cleanup retry (không phụ thuộc Redis): quét task đến hạn mỗi 60s
  // + một lần ngay khi boot (task sót từ lần chạy trước/crash giữa chừng).
  sweepProjectCleanupTasks().catch((e) => console.error('[Cleanup] boot sweep lỗi:', e?.message || e))
  const cleanupSweepTimer = setInterval(() => {
    sweepProjectCleanupTasks().catch((e) => console.error('[Cleanup] sweep lỗi:', e?.message || e))
  }, 60_000)
  if (typeof cleanupSweepTimer.unref === 'function') cleanupSweepTimer.unref()
```

Rationale (document in code comment): `INSTANCE_MODE` is forced `single` (config.js throws otherwise), so one in-process interval is a complete retry driver even when Redis is down; the BullMQ hourly sweep remains untouched.

- [ ] **Step 7: Run test → PASS**; regression: `node tests/filesystemSecurity.test.mjs; node tests/postCommitBoundaries.test.mjs; node tests/redisGuard.test.mjs; node tests/queueLifecycle.test.mjs; node tests/uploadCleanupWorker.test.mjs; npm run lint`.
If `postCommitBoundaries` `deleteSingleCommit` asserts `saveCalls === 1` — still true (one tx, one save). Its source fences (`withTransaction(`, `deleteProjectFiles(` inside try, no `await deleteProjectTranscript`) remain true.

---

### Task 7: Cancel invariant — no new stage after cancellation

**Files:**
- Modify: `backend/src/pipeline/runner.js`
- Test: `backend/tests/cancelStageGuard.test.mjs` (new)

**Interfaces:**
- Produces: `setStageImplOverride(type, fn)` / `clearStageImplOverrides()` (test seam); loop-level cancel check in `runPipelineOwned`.
- Consumes: `cancelProjectUseCase` (unchanged — its commit sets `status='cancelled'`, `run_token=NULL`, aborts signal).

- [ ] **Step 1: Write failing test `backend/tests/cancelStageGuard.test.mjs`**

Harness: tmp DB, `initSchema()`, insert user; create project via real `createProjectWithAdmission` (SUMMARY mode → groups are single stages; no FFmpeg/provider needed because impls are faked). Subscribe nothing — record stage starts via overrides.

```js
const runner = await import('../src/pipeline/runner.js')
const starts = []
let releaseStage1
const gate = new Promise((r) => { releaseStage1 = r })
runner.setStageImplOverride('summary.transcribe', async () => {
  starts.push('summary.transcribe')
  await gate
  return {}
})
runner.setStageImplOverride('summary.sceneDetect', async () => { starts.push('summary.sceneDetect'); return {} })

try {
  const admission = await createProjectWithAdmission({ id: uuidv4(), userId: user.id, mode: 'SUMMARY', title: 'Cancel guard', params: {}, copyrightAcknowledged: true })
  assert(admission.admitted, 'project được admit (pending)')
  const runPromise = runner.runPipeline(admission.project.id, null, admission.runToken)

  // chờ stage 1 thực sự bắt đầu
  await new Promise((r) => { const t = setInterval(() => { if (starts.includes('summary.transcribe')) { clearInterval(t); r() } }, 5) })

  // CANCEL giữa chừng (use case thật: 1 transaction + abort signal)
  const cancelled = await cancelProjectUseCase(admission.project.id)
  assert(cancelled.status === 'cancelled', 'project cancelled')

  releaseStage1()
  await Promise.race([runPromise, new Promise((r) => setTimeout(r, 5000))])

  assert.deepEqual(starts, ['summary.transcribe'], `KHÔNG stage nào sau cancel (thực tế: ${JSON.stringify(starts)})`)
  const proj = await queryOne('SELECT * FROM projects WHERE id = ?', [admission.project.id])
  assert(proj.status === 'cancelled' && proj.run_token === null, 'project giữ cancelled, không bị ghi đè failed/completed')
  const jobs = await query(`SELECT type, status FROM generation_jobs WHERE project_id = ?`, [admission.project.id])
  const later = jobs.filter((j) => j.type !== 'summary.transcribe')
  assert(later.every((j) => j.status !== 'success' && j.status !== 'running'), 'không stage sau cancel ở trạng thái success/running')
  assert(jobs.find((j) => j.type === 'summary.sceneDetect')?.status === 'cancelled', 'stage 2 giữ cancelled từ cancel tx')
} finally {
  runner.clearStageImplOverrides()
}
```

- [ ] **Step 2: Run → verify FAIL/INCOMPLETE** (today stage-2 start depends on timing of the executeStage ownership fence — the explicit loop guard is what we're adding; if it happens to pass, the test still pins the invariant).

- [ ] **Step 3: Add explicit pre-stage guard in `backend/src/pipeline/runner.js`**

In `runPipelineOwned`, inside the group loop — replace lines 849-855 and remove the now-redundant end-of-loop reload at line 919:

```js
    for (const group of stageGroups) {
      const types = Array.isArray(group) ? group : [group]

      if (!started) {
        if (types.includes(effectiveFrom)) started = true
        else continue
      }

      // Cancel invariant: reload TRƯỚC MỖI group. cancelProjectUseCase đã
      // commit status='cancelled' + run_token=NULL → dừng graceful ở đây,
      // không gọi executeStage, không ghi thêm job/project nào. (executeStage
      // cũng có fence ownership — đây là lớp bảo vệ tường minh ở ranh giới stage.)
      const latest = await queryOne('SELECT * FROM projects WHERE id = ?', [projectId])
      if (!latest || latest.status !== 'running' || latest.run_token !== runToken) return
      currentProject = latest

      let groupFailed = false
      // ...rest unchanged...
```

Delete line 919 (`currentProject = await queryOne(...) || currentProject`) — the top-of-loop reload now covers it (same query count, moved from end to start).

- [ ] **Step 4: Add test seam near `STAGE_IMPL` (line 260)**

```js
// Test seam: regression test thay stage impl bằng fake (không chạy provider/
// FFmpeg thật). Production không gọi; tests set/clear tường minh.
const stageImplOverrides = new Map()
export function setStageImplOverride(type, impl) { stageImplOverrides.set(type, impl) }
export function clearStageImplOverrides() { stageImplOverrides.clear() }
```

In `executeStage` line 602: `const impl = stageImplOverrides.get(job.type) || STAGE_IMPL[job.type]`.

- [ ] **Step 5: Run test → PASS**; regression: `node tests/pipelineRetry.test.mjs; node tests/concurrencyLimit.test.mjs; node tests/projectAdmission.test.mjs; node tests/postCommitBoundaries.test.mjs; node tests/heartbeatRecovery.test.mjs; node tests/quarantine.test.mjs; npm run lint`.
If pipeline source-fence tests assert exact loop strings, verify with `rg -n "for \(const group of stageGroups\)" backend/tests` before editing — adapt only fences that quote the moved reload (move, don't delete, their assertion intent: project reload still exists at `SELECT * FROM projects WHERE id = ?`).

---

### Task 8: README operational contract

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Env contract** — replace/extend the `.env` sample (§6.2, lines ~200-214) and add an env table:

```markdown
#### Biến môi trường bắt buộc (production)

| Biến | Mô tả |
|---|---|
| `JWT_ACCESS_SECRET` | Bí mật JWT access token (≥32 ký tự) |
| `JWT_REFRESH_SECRET` | Bí mật JWT refresh token (≥32 ký tự) |
| `MASTER_KEY` | Khối master cho dữ liệu nhạy cảm (≥32 ký tự) |
| `REDIS_HOST` / `REDIS_PORT` | Redis cho BullMQ (bắt buộc ở production — server exit(1) nếu thiếu) |
| `STORAGE_DIR` | Gốc storage (mọi path cleanup bị khoá trong đây) |
| `DB_PATH` | Đường dẫn SQLite (mặc định `./data.db`) |
| `COOKIE_SECURE` | Tuỳ chọn: `true|false`, mặc định `true` khi `NODE_ENV=production` |
```

Note: production fail-fast khi thiếu secret (config.js `assertProductionSecrets`); không ghi secret thật vào README.

- [ ] **Step 2: Auth contract section** — add (§8 API map area):

```markdown
#### Xác thực
- Access token (JWT 15 phút): client giữ **trong bộ nhớ RAM** (không localStorage).
- Refresh token (7 ngày): **HttpOnly cookie** `refresh_token`, `Path=/api/v1/auth`, `SameSite=Lax`, `Secure` khi production. Rotation nguyên tử: mỗi `POST /auth/refresh` chỉ thành công đúng 1 lần cho mỗi token cũ (CAS).
- `POST /auth/refresh` vẫn nhận `refreshToken` trong body / header `x-refresh-token` như **fallback deprecated** — sẽ bị gỡ sau 2 release. Deploy cross-origin phải cùng-site hoặc dùng fallback này trong thời gian chuyển đổi.
- `POST /auth/logout` không yêu cầu access token còn hạn (xác thực bằng Bearer hoặc chính refresh cookie) — luôn xóa được cookie.
- `POST /auth/reset-password`: token một lần nguyên tử (claim trong transaction); đổi mật khẩu đồng thời thu hồi refresh token hiện tại.
```

- [ ] **Step 3: Projects contract** — add to API map:

```markdown
- `POST /api/v1/projects`: header tùy chọn `Idempotency-Key` (1-128 ký tự, unique per user) — retry không tạo duplicate project, lần retry trả `idempotentReplay: true` cùng project id. Lỗi copy transcript cache → **202** với `transcriptCopyFailed: true` (project đã tồn tại, chạy `queued`).
- `DELETE /api/v1/projects/:id`: DB xóa nguyên tử + ghi task `project_cleanup_tasks` trong cùng transaction; file được dọn post-commit, thất bại → retry mỗi 60s (backoff, tối đa 10 lần, sau đó log ALERT). Không phụ thuộc Redis.
- `GET /health` → `{ status, redis, queueSystem, database, writes }` — dùng cho readiness probe.
```

- [ ] **Step 4: Fix counts & verify** — replace stale "76 test files" (lines 153, 262) with the actual count: `(Get-ChildItem backend\tests\*.test.mjs).Count` after all new tests (expected 84). Verify §6.1/§7 still accurate (Redis, FFmpeg, `npm run check:redis`, frontend lint/typecheck/build). Do NOT touch AGENTS.md (out of scope).

- [ ] **Step 5: Cross-check** — `docker-compose.yml`/`docker/nginx.conf` need no change (nginx forwards Set-Cookie + Cookie by default, same-origin). Confirm README Docker section mentions nothing contradicting cookie auth.

---

### Task 9: Full verification & report

**No code changes. Evidence only. Never use `|| true`, `|| echo`, `exit 0`.**

- [ ] **Step 1: Backend suite**

```
cd backend
npm ci
npm run lint
npm test          (full — all *.test.mjs via scripts/run-tests.mjs; generous timeout ≥20min)
```
Individually re-run and record: `refreshRotationRace`, `sseTicketRace`, `passwordResetRace`, `passwordReset`, `persistenceAtomicity`, `postCommitBoundaries`, `revisionProvenance`, `filesystemSecurity`, `projectIdempotency`, `cleanupDurability`, `cancelStageGuard`.
Expected: `ALL TEST FILES PASS`. Any FAIL → debug + fix (do not weaken assertions).

- [ ] **Step 2: Frontend**

```
cd frontend
npm ci
npm run lint
npm run typecheck
npm run build
node --test src/api/refreshFlight.test.js
```

- [ ] **Step 3: Docker**

```
docker compose config --quiet
docker build -f docker/api.Dockerfile .     (if docker daemon available)
docker build -f docker/web.Dockerfile .
```
If docker CLI/daemon unavailable → record BLOCKED + exact error.

- [ ] **Step 4: Fresh-checkout proof**

Copy the working tree (changes are uncommitted; git clone impossible) to a temp dir excluding `node_modules`, `dist`, `data.db`, `storage`, `*.log`:

```
robocopy D:\E\Video_AI <TEMP>\vidai-fresh /E /XD node_modules dist storage .git /XF data.db *.log
cd <TEMP>\vidai-fresh\backend; npm ci; npm run lint; npm test
cd <TEMP>\vidai-fresh\frontend; npm ci; npm run lint; npm run typecheck; npm run build
```
Expected: PASS — proves no reliance on local state. If `npm ci` fails on network → record BLOCKED + error, retry once with `--prefer-offline`.

- [ ] **Step 5: GitHub Actions**

`git log` HEAD is uncommitted work → no CI run can exist for it. Record: CI workflow file reviewed (`.github/workflows/ci.yml` runs backend lint+test, frontend lint+typecheck+build, `docker compose config` — our verification mirrors it exactly); actual run for this change = **BLOCKED (no push allowed by repo git rules)**. Optionally `gh run list` to confirm infra status of last pushed commit — do not claim PASS for HEAD.

- [ ] **Step 6: Final report** — write the report from spec §8 in the final message: Changed files / Refresh token / SSE / Password reset / Frontend auth / Project creation / Project deletion / Cancellation / README / Tests (each command PASS-FAIL-BLOCKED + actual output) / CI / Remaining risks (real ones only, e.g. cross-origin cookie deploy needs same-site or deprecated header until removal; mid-stage ffmpeg subprocess not signal-killed — stages only poll `signal.aborted` at checkpoints; BullMQ hourly sweep unchanged).

---

## Self-Review

- **Spec coverage:** 4.1→Task 1; 4.2→Task 2; 4.3→Task 1f+Task 3; 4.4→Task 1; 4.5/4.6→Task 4; 4.7→Task 5; 4.8→Task 6; 4.9→Task 7; 4.10→Task 8; verification §6→Task 9. All 10 objectives covered.
- **Placeholders:** none — every task carries concrete code/commands. Task 5 Step 2 notes two runtime-dependent details (style preset slug; armed-save 503 case) with explicit instructions to resolve them from seed/`postCommitBoundaries` patterns at execution.
- **Type consistency:** `rotateRefreshToken(userId, oldHash, plain)` used in Task 1 refresh; `runCleanupTask(task)` shape `{id, project_id, keys_json, attempts}` matches both INSERT (Task 6 Step 5) and sweep SELECT; `createProjectPostDeps.{copyTranscript,runPipeline}` named identically in seam, route usage, and test; `createSingleFlight().pending()` used in client.js and covered in the frontend test.
- **Ordering:** Task 1 before 2/3 (shares `runAffected` import + auth.js edits); Task 4 after 1 (cookie flow); Task 5 before 6 (idempotency-row cleanup in DELETE belongs to Task 5 Step 6 but is exercised by Task 6 tests); Task 9 last.
