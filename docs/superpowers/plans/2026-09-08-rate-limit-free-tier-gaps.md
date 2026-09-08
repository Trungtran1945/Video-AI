# Rate Limiting & Free Tier — Gap Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 13 specific gaps in the existing flat codebase to align with doc 11 (Rate Limiting & Free Tier) spec.

**Architecture:** Modify existing `backend/` + `frontend/` flat structure. No restructure. Backend: fix `tracked()`, add retry logic, fix quota guard, normalize input hash, migrate stages to `callProvider()`, add batch/tier config. Frontend: enhance ApiKeys, add wizard warning, add retry UI. All changes are surgical — touch only what's needed.

**Tech Stack:** Node.js 18+ (ES modules), Express, sql.js, React 18, Vite, TailwindCSS, Zustand, Framer Motion

**Spec:** `docs/superpowers/specs/2026-09-08-rate-limit-free-tier-gaps-design.md`

## Global Constraints

- No monorepo restructure — keep `backend/` + `frontend/` flat structure
- No Prisma — keep sql.js with raw SQL
- No breaking changes to existing API contract (additive only)
- Every change must pass `npm run lint` (frontend) and `node --test` (backend tests)
- Dark theme UI: `#0F1117` background, rounded cards, blue accent, framer-motion transitions
- SQLite migration via `ALTER TABLE` in `schema.js` (try/catch pattern)

---

## File Map

| File | Change |
|------|--------|
| `backend/src/db/schema.js` | Add `next_retry_at` column to `generation_jobs` |
| `backend/src/providers/tracked.js` | Add `isRateLimitError()`, classify `rate_limited` status |
| `backend/src/lib/callProvider.js` | Normalize input hash (sorted keys, trimmed strings) |
| `backend/src/services/quotaGuardService.js` | Read limits from `provider_rate_limits` table |
| `backend/src/providers/registry.js` | Return `apiKeyId` in `getProvider()`, add `PROV_002` |
| `backend/src/pipeline/runner.js` | Retry logic for rate-limited jobs |
| `backend/src/pipeline/stages/summaryAnalyze.js` | Batch keyframes, use `callProvider()` |
| `backend/src/pipeline/stages/summaryScript.js` | Use `callProvider()` |
| `backend/src/pipeline/stages/summaryAlign.js` | Use `callProvider()` |
| `backend/src/pipeline/stages/summaryTranscribe.js` | Use `callProvider()` |
| `backend/src/pipeline/stages/dubStt.js` | Use `callProvider()` |
| `backend/src/pipeline/stages/dubOcr.js` | Use `callProvider()`, tier-aware fps |
| `backend/src/pipeline/stages/dubTranslate.js` | Use `callProvider()`, tier-aware window |
| `backend/src/pipeline/stages/dubTtsAlign.js` | Use `callProvider()` |
| `backend/src/providers/vision/geminiVision.js` | Add `describeBatch()` |
| `backend/src/routes/v1/providers.js` | Add `GET /:provider/quota` |
| `backend/src/routes/v1/apiKeys.js` | Accept `tier`, `priority` in POST/PUT |
| `frontend/src/pages/ApiKeys.jsx` | Label/priority/tier form + quota display |
| `frontend/src/pages/CreateProject.jsx` | Free-tier warning |
| `frontend/src/pages/Queue.jsx` | Retry/quota_risk display |
| `frontend/src/pages/ProjectDetail.jsx` | Retry/quota_risk display |
| `frontend/src/lib/constants.jsx` | Add RETRY status label |
| `backend/.env.example` | New file with rate-limit env vars |

---

### Task 1: Schema Migration — Add `next_retry_at`

**Files:**
- Modify: `backend/src/db/schema.js:130`

- [ ] **Step 1: Add column migration**

In `backend/src/db/schema.js`, after the existing `generation_jobs` ALTER TABLE lines (around line 130), add:

```js
// Group 5: Retry scheduling for rate-limited jobs (docs/11 §4.2)
try { db.run(`ALTER TABLE generation_jobs ADD COLUMN next_retry_at TEXT`) } catch (_) {}
```

- [ ] **Step 2: Verify schema loads without error**

Run: `node -e "import('./backend/src/db/schema.js').then(m => m.initSchema())"`
Expected: `[DB] Schema initialized (sql.js)` with no errors

- [ ] **Step 3: Commit**

```bash
git add backend/src/db/schema.js
git commit -m "feat(db): add next_retry_at column to generation_jobs"
```

---

### Task 2: `tracked()` Rate-Limit Classification

**Files:**
- Modify: `backend/src/providers/tracked.js:47,72-80`

**Interfaces:**
- Consumes: `RateLimitExhaustedError` (from `lib/rateLimiter.js`)
- Produces: `tracked()` now logs `status: 'rate_limited'` for rate-limit errors

- [ ] **Step 1: Add `isRateLimitError()` helper**

In `backend/src/providers/tracked.js`, add before the `tracked()` function:

```js
function isRateLimitError(err) {
  if (err?.name === 'RateLimitExhaustedError') return true
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    || msg.includes('insufficient_quota') || msg.includes('retry-after')
}
```

- [ ] **Step 2: Update `logProviderCall()` status mapping**

In `backend/src/providers/tracked.js`, line 47, change:

```js
// Before:
status: entry.status === 'error' ? 'error' : 'ok',

// After:
status: entry.status === 'rate_limited' ? 'rate_limited'
  : entry.status === 'error' ? 'error' : 'ok',
```

- [ ] **Step 3: Update `tracked()` catch block**

In `backend/src/providers/tracked.js`, in the catch block (around line 72-80), change:

```js
// Before:
await logProviderCall({
  ...meta,
  durationMs: Date.now() - start,
  status: 'error',
  error: err.message,
})

// After:
await logProviderCall({
  ...meta,
  durationMs: Date.now() - start,
  status: isRateLimitError(err) ? 'rate_limited' : 'error',
  error: err.message,
})
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/providers/tracked.js
git commit -m "feat(tracked): classify rate-limit errors as rate_limited status"
```

---

### Task 3: Input Hash Normalization

**Files:**
- Modify: `backend/src/lib/callProvider.js:24-27`

**Interfaces:**
- Consumes: raw input objects from pipeline stages
- Produces: deterministic SHA-256 hash regardless of key ordering or whitespace

- [ ] **Step 1: Add `normalizeInput()` and update `inputHash()`**

In `backend/src/lib/callProvider.js`, replace lines 24-27:

```js
// Before:
function inputHash(provider, type, model, input) {
  const payload = JSON.stringify({ provider, type, model, input })
  return crypto.createHash('sha256').update(payload).digest('hex')
}

// After:
function normalizeInput(input) {
  if (typeof input === 'string') return input.trim()
  if (typeof input !== 'object' || input === null) return input
  if (Array.isArray(input)) return input.map(normalizeInput)
  const sorted = {}
  for (const key of Object.keys(input).sort()) {
    sorted[key] = normalizeInput(input[key])
  }
  return sorted
}

function inputHash(provider, type, model, input) {
  const normalized = normalizeInput(input)
  const payload = JSON.stringify({ provider, type, model, input: normalized })
  return crypto.createHash('sha256').update(payload).digest('hex')
}
```

- [ ] **Step 2: Verify hash consistency**

Run: `node -e "
import { inputHash } from './backend/src/lib/callProvider.js'
const h1 = inputHash('gemini', 'llm', 'flash', { b: 2, a: 1 })
const h2 = inputHash('gemini', 'llm', 'flash', { a: 1, b: 2 })
const h3 = inputHash('gemini', 'llm', 'flash', { a: ' 1 ', b: '2' })
console.log('same keys diff order:', h1 === h2)  // true
console.log('whitespace trimmed:', h1 === h3)     // true
"`
Expected: both `true`

- [ ] **Step 3: Commit**

```bash
git add backend/src/lib/callProvider.js
git commit -m "fix(cache): normalize input hash for deterministic caching"
```

---

### Task 4: QuotaGuardService — Read from `provider_rate_limits`

**Files:**
- Modify: `backend/src/services/quotaGuardService.js:15-51`

**Interfaces:**
- Consumes: `provider_rate_limits` table (seeded in `schema.js`)
- Produces: `QuotaSnapshot` with actual `limitToday` and `limitThisMinute` values

- [ ] **Step 1: Fix `getQuotaSnapshot()` to query actual limits**

Replace the `getQuotaSnapshot()` function in `backend/src/services/quotaGuardService.js`:

```js
export async function getQuotaSnapshot(userId, provider) {
  const now = new Date()
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString()

  // Count calls in last 24h
  const dailyResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?`,
    [userId, provider, oneDayAgo]
  )
  const usedToday = dailyResult?.cnt || 0

  // Count calls in last minute
  const minuteResult = await queryOne(
    `SELECT COUNT(*) as cnt FROM provider_logs pl
     JOIN projects p ON pl.project_id = p.id
     WHERE p.user_id = ? AND pl.provider = ? AND pl.created_date >= ?`,
    [userId, provider, oneMinuteAgo]
  )
  const usedThisMinute = minuteResult?.cnt || 0

  // Get rate limit config from provider_rate_limits table
  const limit = await queryOne(
    `SELECT * FROM provider_rate_limits
     WHERE provider = ? AND (user_id = ? OR user_id IS NULL)
     ORDER BY user_id DESC LIMIT 1`,
    [provider, userId]
  )
  const limitToday = limit?.requests_per_day || null
  const limitThisMinute = limit?.requests_per_minute || null

  // percentUsed = max(daily%, minute%)
  const pctDaily = limitToday ? usedToday / limitToday : 0
  const pctMinute = limitThisMinute ? usedThisMinute / limitThisMinute : 0
  const percentUsed = Math.max(pctDaily, pctMinute) * 100

  return {
    provider,
    usedToday,
    limitToday,
    usedThisMinute,
    limitThisMinute,
    percentUsed,
  }
}
```

- [ ] **Step 2: Fix `checkQuotaWarning()` to use percentUsed correctly**

In `checkQuotaWarning()`, the threshold check should compare `percentUsed` (0-100 scale) against `threshold * 100`:

```js
if (snapshot.percentUsed >= threshold * 100) {
```

This is already correct — verify it still works with the new `percentUsed` (now 0-100 instead of 0-1).

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/quotaGuardService.js
git commit -m "feat(quota): read limits from provider_rate_limits table"
```

---

### Task 5: `getProvider()` Returns `apiKeyId` + `PROV_002`

**Files:**
- Modify: `backend/src/providers/registry.js:110-166`

**Interfaces:**
- Consumes: `api_keys` table (with `id` column)
- Produces: `{ id, provider, apiKeyId }` from `getProvider()`

- [ ] **Step 1: Extend `resolveApiKey()` to return key ID**

In `backend/src/providers/registry.js`, change `resolveApiKey()` to return both key and id:

```js
async function resolveApiKey(userId, providerId) {
  const rows = await query(
    `SELECT id, encrypted_key FROM api_keys WHERE user_id = ? AND provider = ? AND is_active = 1 ORDER BY created_date DESC`,
    [userId, providerId]
  )
  for (const row of rows) {
    if (!row.encrypted_key) continue
    try {
      const key = decrypt(row.encrypted_key)
      if (key) return { key, apiKeyId: row.id }
    } catch (_) {}
  }
  for (const envName of ENV_KEYS[providerId] || []) {
    if (process.env[envName]) return { key: process.env[envName], apiKeyId: null }
  }
  return { key: null, apiKeyId: null }
}
```

- [ ] **Step 2: Update `getProvider()` to use new return shape**

```js
export async function getProvider(userId, type, { id } = {}) {
  const providerId = id || (await getUserChoice(userId, type))
  const factory = REGISTRY[type]?.[providerId]
  if (factory === undefined) {
    throw new ProviderError(
      `Không có nhà cung cấp '${type}' với id '${providerId}'. Các lựa chọn hợp lệ: ${Object.keys(REGISTRY[type] || {}).join(', ')}`
    )
  }
  if (factory === null) {
    throw new ProviderError(
      `${PROVIDER_LABELS[providerId] || providerId} chưa được hỗ trợ trên máy chủ này. Hãy chọn nhà cung cấp khác trong Cài đặt.`
    )
  }
  if (KEYLESS.has(providerId)) {
    return { id: providerId, provider: factory(null), apiKeyId: null }
  }
  const { key: apiKey, apiKeyId } = await resolveApiKey(userId, providerId)
  if (!apiKey) {
    // OCR: fallback to Tesseract local if no key
    if (type === 'ocr' && REGISTRY.ocr?.tesseract) {
      console.warn(`[provider] ocr '${providerId}' thiếu API key — dùng Tesseract local`)
      return { id: 'tesseract', provider: REGISTRY.ocr.tesseract(null), apiKeyId: null }
    }
    throw new ProviderError(
      `Chưa cấu hình API key cho ${PROVIDER_LABELS[providerId] || providerId}. Thêm key tại trang API Keys (provider: ${providerId}) hoặc đặt biến môi trường ${(ENV_KEYS[providerId] || []).join(' / ')}`,
      'PROV_001'
    )
  }
  return { id: providerId, provider: factory(apiKey), apiKeyId }
}
```

- [ ] **Step 3: Add `PROV_002` error code constant**

```js
export const ERROR_CODES = {
  PROV_001: 'PROV_001', // Missing API key
  PROV_002: 'PROV_002', // All keys for provider exhausted
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/providers/registry.js
git commit -m "feat(registry): return apiKeyId from getProvider, add PROV_002"
```

---

### Task 6: Migrate Pipeline Stages to `callProvider()`

This task migrates all 8 pipeline stages from calling `tracked()` directly to using `callProvider()`. Do each stage as a sub-step.

**Files:**
- Modify: all 8 stage files in `backend/src/pipeline/stages/`

**Pattern for each stage:**

```js
// Before:
import { tracked } from '../../providers/tracked.js'
// ...
const result = await tracked(
  { projectId: project.id, jobId: job.id, provider: someProvider.id, type: 'llm' },
  () => someProvider.provider.complete({ ... })
)

// After:
import { callProvider } from '../../lib/callProvider.js'
// ...
const result = await callProvider({
  provider: someProvider.id,
  type: 'llm',
  model: someProvider.provider.model || someProvider.id,
  input: { prompt: ..., system: ... },
  fn: () => someProvider.provider.complete({ ... }),
  userId: project.user_id,
  apiKeyId: someProvider.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.1: Migrate `summaryTranscribe.js`**

```js
// Change import:
import { callProvider } from '../../lib/callProvider.js'
// Remove: import { tracked } from '../../providers/tracked.js'

// Replace tracked() call with callProvider():
const transcript = await callProvider({
  provider: asr.id,
  type: 'asr',
  model: asr.provider.model || asr.id,
  input: { filePath: uploadFile, language },
  fn: () => asr.provider.transcribe(uploadFile, { language }),
  userId: project.user_id,
  apiKeyId: asr.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.2: Migrate `summaryAnalyze.js`**

Replace the `tracked()` call in the loop with `callProvider()` (batching will be added in Task 7):

```js
import { callProvider } from '../../lib/callProvider.js'

// In the loop:
const described = await callProvider({
  provider: vision.id,
  type: 'vision',
  model: vision.provider.model || vision.id,
  input: { imagePath: thumbPath },
  fn: () => vision.provider.describeImage({ imagePath: thumbPath }),
  userId: project.user_id,
  apiKeyId: vision.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.3: Migrate `summaryScript.js`**

```js
import { callProvider } from '../../lib/callProvider.js'

const res = await callProvider({
  provider: llm.id,
  type: 'llm',
  model: llm.provider.model || llm.id,
  input: { system, prompt, json: true },
  fn: () => llm.provider.complete({ system, prompt, json: true, temperature: 0.7, maxOutputTokens: 8192 }),
  userId: project.user_id,
  apiKeyId: llm.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.4: Migrate `summaryAlign.js`**

The align stage calls TTS for duration estimation. Replace `tracked()` with `callProvider()`:

```js
import { callProvider } from '../../lib/callProvider.js'

const ttsResult = await callProvider({
  provider: tts.id,
  type: 'tts',
  model: tts.provider.model || tts.id,
  input: { text: seg.narration, language: settings.defaultLanguage || 'vi' },
  fn: () => tts.provider.synthesize({ text: seg.narration, language: settings.defaultLanguage || 'vi', outPath }),
  userId: project.user_id,
  apiKeyId: tts.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.5: Migrate `dubStt.js`**

```js
import { callProvider } from '../../lib/callProvider.js'

const transcript = await callProvider({
  provider: asr.id,
  type: 'asr',
  model: asr.provider.model || asr.id,
  input: { filePath: audioPath, language },
  fn: () => asr.provider.transcribe(audioPath, { language }),
  userId: project.user_id,
  apiKeyId: asr.apiKeyId,
  projectId: project.id,
  jobId: job.id,
})
```

- [ ] **Step 6.6: Migrate `dubOcr.js`**

Replace `tracked()` in the OCR loop:

```js
import { callProvider } from '../../lib/callProvider.js'

const result = await callProvider({
  provider: ocr.id,
  type: 'ocr',
  model: ocr.provider.model || ocr.id,
  input: { imagePath: f.file, width: dims.width, height: dims.height },
  fn: () => ocr.provider.detectSubtitle({ imagePath: f.file, width: dims.width, height: dims.height }),
  userId: project.user_id,
  apiKeyId: ocr.apiKeyId,
  projectId: project.id,
  jobId: job.id,
}).then((r) => ({ t: f.t, boxes: r.boxes })).catch(() => ({ t: f.t, boxes: [] }))
```

- [ ] **Step 6.7: Migrate `dubTranslate.js`**

Replace `tracked()` in `restyleGroup()` and `translateGroup()`:

```js
import { callProvider } from '../../lib/callProvider.js'

// In restyleGroup:
const call = (pp) => callProvider({
  provider: llm.id,
  type: 'llm',
  model: llm.provider.model || llm.id,
  input: { system, prompt: pp, json: true },
  fn: () => llm.provider.complete({ system, prompt: pp, json: true, temperature: 0.4, maxOutputTokens }),
  userId: projectId ? undefined : undefined, // userId passed from caller
  apiKeyId: llm.apiKeyId,
  projectId,
  jobId: job.id,
})
```

Note: `restyleGroup` and `translateGroup` need `userId` parameter added to their signatures.

- [ ] **Step 6.8: Migrate `dubTtsAlign.js`**

Replace the `synth()` helper and `shortenTranslation()`:

```js
import { callProvider } from '../../lib/callProvider.js'

async function synth(tts, text, outPath, job, projectId, speed = 1) {
  return callProvider({
    provider: tts.id,
    type: 'tts',
    model: tts.provider.model || tts.id,
    input: { text, outPath, speed },
    fn: () => tts.provider.synthesize({ text, outPath, speed }),
    userId: undefined, // passed from caller
    apiKeyId: tts.apiKeyId,
    projectId,
    jobId: job.id,
  })
}
```

Note: `synth()` and `shortenTranslation()` need `userId` parameter.

- [ ] **Step 6.9: Verify all stages compile (no import errors)**

Run: `node -e "import('./backend/src/pipeline/runner.js')"`
Expected: No import errors

- [ ] **Step 6.10: Commit**

```bash
git add backend/src/pipeline/stages/
git commit -m "feat(pipeline): migrate all 8 stages to callProvider()"
```

---

### Task 7: Batch Keyframes in `summaryAnalyze`

**Files:**
- Modify: `backend/src/pipeline/stages/summaryAnalyze.js:42-58`

**Interfaces:**
- Consumes: `callProvider()` from Task 6
- Produces: Processes 5 keyframes per `callProvider()` call instead of 1

- [ ] **Step 1: Implement batch keyframe processing**

Replace the single-keyframe loop in `summaryAnalyze.js`:

```js
const BATCH_SIZE = 5
let done = 0
for (let i = 0; i < keys.length; i += BATCH_SIZE) {
  const batch = keys.slice(i, i + BATCH_SIZE)
  
  // Generate all thumbnails in parallel
  const thumbPaths = await Promise.all(batch.map(scene => {
    const thumbPath = path.join(thumbsDir, `${scene.id}.jpg`)
    return makeThumbnail(src, (scene.start_sec + scene.end_sec) / 2, thumbPath)
      .then(() => ({ scene, thumbPath }))
  }))

  // Single callProvider call — if provider supports batch, use it;
  // otherwise sequential within one call for caching benefit
  const results = await callProvider({
    provider: vision.id,
    type: 'vision',
    model: vision.provider.model || vision.id,
    input: { imagePaths: thumbPaths.map(t => t.thumbPath) },
    fn: async () => {
      if (typeof vision.provider.describeBatch === 'function') {
        return vision.provider.describeBatch({ imagePaths: thumbPaths.map(t => t.thumbPath) })
      }
      // Fallback: sequential calls within single rate-limit slot
      return Promise.all(thumbPaths.map(t =>
        vision.provider.describeImage({ imagePath: t.thumbPath })
      ))
    },
    userId: project.user_id,
    apiKeyId: vision.apiKeyId,
    projectId: project.id,
    jobId: job.id,
  })

  // Process results
  const describedList = Array.isArray(results) ? results : [results]
  for (let j = 0; j < batch.length; j++) {
    const described = describedList[j]
    await run(`UPDATE scenes SET thumbnail_key = ?, description = ?, embedding = ? WHERE id = ?`, [
      toStorageKey(thumbPaths[j].thumbPath),
      described.text.slice(0, 500),
      JSON.stringify(textEmbedding(described.text)),
      batch[j].id,
    ])
    done++
    setProgress(5 + Math.round((done / keys.length) * 92))
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/pipeline/stages/summaryAnalyze.js
git commit -m "feat(analyze): batch 5 keyframes per vision call"
```

---

### Task 8: Tier-Based Config for Translate + OCR

**Files:**
- Modify: `backend/src/pipeline/stages/dubTranslate.js:9`
- Modify: `backend/src/pipeline/stages/dubOcr.js:11`

- [ ] **Step 1: Make `CONTEXT_WINDOW_SEC` tier-aware in `dubTranslate.js`**

```js
// Before:
const CONTEXT_WINDOW_SEC = 30

// After:
// Wider context window for free tier = fewer LLM calls (docs/11 §3.1)
function getContextWindowSec(project) {
  let tier = 'free'
  try { tier = JSON.parse(project.params || '{}').tier || 'free' } catch (_) {}
  return tier === 'free' ? 45 : 30
}
```

Then in `dubTranslate()`, use:
```js
const CONTEXT_WINDOW_SEC = getContextWindowSec(project)
```

- [ ] **Step 2: Make `FRAME_FPS` tier-aware in `dubOcr.js`**

```js
// Before:
const FRAME_FPS = 2

// After:
// Cloud free-tier OCR: reduce fps to save quota (docs/11 §3.1)
function getFrameFps(ocrId) {
  const isCloudOcr = ocrId !== 'tesseract'
  if (isCloudOcr) return Number(process.env.OCR_SAMPLE_FPS) || 0.5
  return 2 // local Tesseract: full fps
}
```

Then in `dubOcr()`, after resolving the provider:
```js
const FRAME_FPS = getFrameFps(ocr.id)
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/pipeline/stages/dubTranslate.js backend/src/pipeline/stages/dubOcr.js
git commit -m "feat(tier): tier-aware context window and OCR fps"
```

---

### Task 9: Pipeline Retry Logic for Rate-Limited Jobs

**Files:**
- Modify: `backend/src/pipeline/runner.js:233-280`

**Interfaces:**
- Consumes: `generation_jobs.next_retry_at` (Task 1), `isRateLimitError()` (Task 2)
- Produces: Jobs get `status: 'retry'` with `nextRetryAt` instead of immediate `failed`

- [ ] **Step 1: Add `isRateLimitError()` import in runner.js**

```js
// Add near top of runner.js:
function isRateLimitError(err) {
  if (err?.name === 'RateLimitExhaustedError') return true
  const msg = (err?.message || '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    || msg.includes('insufficient_quota') || msg.includes('retry-after')
}

function parseRetryAfter(err) {
  const msg = err?.message || ''
  const match = msg.match(/retry[_-]?after[:\s]*(\d+)/i)
  if (match) return parseInt(match[1], 10)
  return null
}

async function getNextRetryAt(provider) {
  // Try to get reset time from provider_rate_limits
  const { queryOne } = await import('../db/query.js')
  const limit = await queryOne(
    `SELECT requests_per_minute FROM provider_rate_limits WHERE provider = ? AND tier = 'free' LIMIT 1`,
    [provider]
  )
  const rpm = limit?.requests_per_minute || 10
  // Next RPM reset = now + 60s (conservative)
  return new Date(Date.now() + 60 * 1000).toISOString()
}
```

- [ ] **Step 2: Add retry check before stage execution**

In `executeStage()`, after setting status to 'running', add a check:

```js
// Check if this is a retry-stage waiting for cooldown
if (job.status === 'retry' && job.next_retry_at) {
  const retryAt = new Date(job.next_retry_at)
  if (Date.now() < retryAt.getTime()) {
    // Not ready yet — skip, pipeline will re-check on next invocation
    await updateById('generation_jobs', job.id, { status: 'retry' })
    return true // don't mark as failed
  }
}
```

- [ ] **Step 3: Modify `failJob()` to handle rate-limit retries**

Replace the error handling in `executeStage()` catch block:

```js
} catch (err) {
  if (isRateLimitError(err)) {
    // Rate-limited: retry with scheduled nextRetryAt (docs/11 §4.2)
    const MAX_RATE_LIMIT_RETRIES = 5
    const attempts = (job.attempts || 0) + 1
    
    if (attempts >= MAX_RATE_LIMIT_RETRIES) {
      // Exhausted all retries → fail with PROV_002
      await failJob(job, projectId, `PROV_002: Tất cả key cho provider đã hết quota sau ${attempts} lần retry`)
      return false
    }
    
    const retryAfter = parseRetryAfter(err)
    const nextRetryAt = retryAfter
      ? new Date(Date.now() + retryAfter * 1000).toISOString()
      : await getNextRetryAt(STAGE_PROVIDER[job.type] || 'unknown')
    
    await updateById('generation_jobs', job.id, {
      status: 'retry',
      step: 'rate_limited',
      attempts,
      next_retry_at: nextRetryAt,
      error_message: `Rate limited: ${err.message}`,
    })
    eventBus.publish(projectId, {
      stage: job.type,
      status: 'retry',
      nextRetryAt,
      percent: 0,
    })
    return true // don't mark project as failed
  }
  
  // Regular error → existing failJob logic
  await failJob(job, projectId, err.message)
  return false
}
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/pipeline/runner.js
git commit -m "feat(runner): retry rate-limited jobs with scheduled nextRetryAt"
```

---

### Task 10: `GET /providers/:provider/quota` Endpoint

**Files:**
- Modify: `backend/src/routes/v1/providers.js`

- [ ] **Step 1: Add quota endpoint**

In `backend/src/routes/v1/providers.js`, add before `export default`:

```js
import { getQuotaSnapshot } from '../../services/quotaGuardService.js'

// GET /api/v1/providers/:provider/quota — quota usage for current user
router.get('/:provider/quota', async (req, res) => {
  try {
    const snapshot = await getQuotaSnapshot(req.user.id, req.params.provider)
    res.json(snapshot)
  } catch (err) {
    console.error('Quota error:', err)
    sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error')
  }
})
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/routes/v1/providers.js
git commit -m "feat(api): add GET /providers/:provider/quota endpoint"
```

---

### Task 11: ApiKeys — Accept `tier`/`priority`, Add Quota Display

**Files:**
- Modify: `backend/src/routes/v1/apiKeys.js:25-36,48-57`
- Modify: `frontend/src/pages/ApiKeys.jsx`

- [ ] **Step 1: Backend — accept `tier` and `priority` in POST**

In `backend/src/routes/v1/apiKeys.js`, update the POST handler:

```js
router.post('/', async (req, res) => {
  const { provider, label, key, tier, priority } = req.body || {}
  if (!provider || !key) return sendError(res, 400, ERR.VALIDATION, 'provider and key are required', { field: 'provider,key' })
  const row = await insert('api_keys', {
    id: uuidv4(),
    user_id: req.user.id,
    provider,
    label: label || provider,
    encrypted_key: encrypt(key),
    is_active: 1,
    tier: tier || 'free',
    priority: priority || 0,
  })
  res.json({ id: row.id, provider: row.provider, label: row.label, tier: row.tier, priority: row.priority, is_active: row.is_active, keyPreview: mask(key) })
})
```

- [ ] **Step 2: Backend — accept `tier`/`priority` in PUT**

```js
router.put('/:id', async (req, res) => {
  const row = await queryOne('SELECT * FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])
  if (!row) return sendError(res, 404, 'NOT_FOUND', 'Not found')
  const patch = {}
  if (typeof req.body?.isActive === 'boolean') patch.is_active = req.body.isActive ? 1 : 0
  if (typeof req.body?.label === 'string') patch.label = req.body.label
  if (typeof req.body?.tier === 'string') patch.tier = req.body.tier
  if (typeof req.body?.priority === 'number') patch.priority = req.body.priority
  await run(
    'UPDATE api_keys SET is_active = ?, label = ?, tier = ?, priority = ? WHERE id = ?',
    [patch.is_active ?? row.is_active, patch.label ?? row.label, patch.tier ?? row.tier, patch.priority ?? row.priority, req.params.id]
  )
  const updated = await queryOne('SELECT id, provider, label, is_active, tier, priority FROM api_keys WHERE id = ?', [req.params.id])
  res.json(updated)
})
```

- [ ] **Step 3: Backend — include `tier`/`priority` in GET response**

Update the GET query to include `tier` and `priority`:

```js
router.get('/', async (req, res) => {
  const rows = await query('SELECT id, user_id, provider, label, is_active, tier, priority, created_date, encrypted_key FROM api_keys WHERE user_id = ? ORDER BY created_date DESC', [req.user.id])
  res.json(rows.map((r) => ({ ...r, keyPreview: mask(decrypt(r.encrypted_key)), encrypted_key: undefined })))
})
```

- [ ] **Step 4: Frontend — add label/priority/tier form fields**

In `frontend/src/pages/ApiKeys.jsx`, update the form state and add fields:

```jsx
// Update form state:
const [form, setForm] = useState({ provider: 'gemini', category: 'llm', api_key_encrypted: '', label: '', tier: 'free', priority: 0 });

// Add to form UI (after category select):
<div className="grid grid-cols-3 gap-3 mb-3">
  <input type="text" value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
    placeholder="Label (optional)"
    className="px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50" />
  <select value={form.tier} onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
    className="px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50">
    <option value="free">Free</option>
    <option value="paid">Paid</option>
    <option value="custom">Custom</option>
  </select>
  <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 0 }))}
    min="0" max="10" placeholder="Priority"
    className="px-3 py-2 rounded-lg bg-[#0F1117] border border-white/5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50" />
</div>
```

Update `handleAdd()` to pass new fields:

```jsx
const created = await apiKeysApi.create(form.provider, form.category, form.api_key_encrypted, form.label, form.tier, form.priority);
```

- [ ] **Step 5: Frontend — update `apiKeysApi.create()` to pass new params**

In `frontend/src/api/extra.js`, update the `create` function:

```js
create: (provider, category, key, label, tier, priority) =>
  client.post('/api-keys', { provider, label: label || provider, key, tier: tier || 'free', priority: priority || 0 }).then(r => r.data),
```

- [ ] **Step 6: Frontend — show tier and priority in key list**

In the key list item, add tier/priority badges:

```jsx
<span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-slate-400 uppercase">{k.tier || 'free'}</span>
<span className="px-1.5 py-0.5 rounded bg-white/5 text-[10px] text-slate-400">P{k.priority || 0}</span>
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/v1/apiKeys.js frontend/src/pages/ApiKeys.jsx frontend/src/api/extra.js
git commit -m "feat(apikeys): accept tier/priority, display in UI"
```

---

### Task 12: Free-Tier Wizard Warning

**Files:**
- Modify: `frontend/src/pages/CreateProject.jsx`

- [ ] **Step 1: Add warning banner after provider selection**

In `CreateProject.jsx`, after the provider/voice selection step, add a warning component:

```jsx
function FreeTierWarning({ mode, estimatedDuration }) {
  const thresholds = { SUMMARY: 60 * 60, TRANSLATE_DUB: 20 * 60 }
  const threshold = thresholds[mode]
  if (!threshold || estimatedDuration <= threshold) return null
  
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 mb-4">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm text-amber-200 font-medium">Cảnh báo free tier</p>
        <p className="text-xs text-amber-300/70 mt-1">
          Với API key miễn phí, xử lý nội dung dài có thể chậm hơn nhiều do giới hạn tốc độ của nhà cung cấp.
          Khuyến nghị test với clip ngắn (≤ 10 phút) trước.
        </p>
      </div>
    </div>
  )
}
```

Place `<FreeTierWarning />` in the generate/confirm step, passing estimated duration from form state.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/CreateProject.jsx
git commit -m "feat(wizard): add free-tier warning for long content"
```

---

### Task 13: Queue/ProjectDetail Retry UI

**Files:**
- Modify: `frontend/src/lib/constants.jsx`
- Modify: `frontend/src/pages/Queue.jsx`
- Modify: `frontend/src/pages/ProjectDetail.jsx`

- [ ] **Step 1: Add RETRY status label in constants.jsx**

In `frontend/src/lib/constants.jsx`, add to `STATUS_LABELS`:

```js
retry: { label: 'Đang chờ retry', color: 'text-amber-400', bg: 'bg-amber-500/10', icon: Clock },
```

Import `Clock` from lucide-react if not already imported.

- [ ] **Step 2: Queue page — show retry status with recovery time**

In `frontend/src/pages/Queue.jsx`, when rendering job status, add retry handling:

```jsx
{job.status === 'retry' ? (
  <div className="flex items-center gap-2">
    <Clock className="w-4 h-4 text-amber-400" />
    <span className="text-sm text-amber-400">
      Đang chờ quota hồi phục lúc {new Date(job.next_retry_at).toLocaleTimeString('vi-VN')}
    </span>
  </div>
) : job.result?.warnings?.some(w => w.type === 'quota_risk') ? (
  <div className="flex items-center gap-2">
    <AlertTriangle className="w-4 h-4 text-yellow-400" />
    <span className="text-sm text-yellow-400">Sắp chạm giới hạn API</span>
  </div>
) : (
  // existing status display
)}
```

- [ ] **Step 3: ProjectDetail — show retry/quota_risk in pipeline stages**

In `frontend/src/pages/ProjectDetail.jsx`, in the pipeline stage rendering, add similar retry/quota_risk display.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/constants.jsx frontend/src/pages/Queue.jsx frontend/src/pages/ProjectDetail.jsx
git commit -m "feat(ui): show retry status and quota_risk warnings"
```

---

### Task 14: `.env.example` + Final Cleanup

**Files:**
- Create: `backend/.env.example`

- [ ] **Step 1: Create `.env.example`**

```env
# ── Rate Limiting / Free Tier (docs/11) ──
PROVIDER_RATE_LIMIT_SAFETY_MARGIN=0.8
PROVIDER_CACHE_ENABLED=true
PROVIDER_CACHE_TTL_DAYS=90
QUOTA_WARNING_THRESHOLD=0.8
DEFAULT_PROVIDER_MODE=live    # 'live' | 'mock'
OCR_SAMPLE_FPS=0.5            # cloud OCR fps for free tier
```

- [ ] **Step 2: Commit**

```bash
git add backend/.env.example
git commit -m "docs: add .env.example with rate-limit config"
```

---

### Task 15: Verification

- [ ] **Step 1: Run backend lint/check**

```bash
cd backend && node -e "import('./src/pipeline/runner.js').then(() => console.log('OK'))"
```

Expected: No import errors

- [ ] **Step 2: Run frontend lint**

```bash
cd frontend && npm run lint
```

Expected: No errors

- [ ] **Step 3: Run frontend build**

```bash
cd frontend && npm run build
```

Expected: Build succeeds

- [ ] **Step 4: Run existing tests**

```bash
cd backend && node tests/dubTranslate.backfill.test.mjs
```

Expected: PASS

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete rate-limit free-tier gap fixes (doc 11 alignment)"
```
