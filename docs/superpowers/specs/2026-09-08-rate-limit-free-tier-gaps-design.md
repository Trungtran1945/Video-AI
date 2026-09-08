# Rate Limiting & Free Tier — Gap Fix Design

**Date:** 2026-09-08
**Scope:** Fix specific gaps in existing flat codebase (backend/frontend) to match doc 11 spec
**Not in scope:** Monorepo restructure, Prisma migration, full refactor

---

## Context

The existing codebase already implements most of doc 11 (Rate Limiting & Free Tier):
- `lib/rateLimiter.js` — Token Bucket + Sliding Window
- `lib/callProvider.js` — Provider call wrapper with cache + rate limiting
- `services/quotaGuardService.js` — Quota monitoring (partial)
- `providers/*/mock*.js` — Mock providers for dev/CI
- `db/schema.js` — Seeded rate limits, provider_cache table

However, several specific gaps remain that prevent full alignment with the doc spec.

---

## Gap Summary

| # | Gap | Severity | Files |
|---|-----|----------|-------|
| 1 | `tracked()` misclassifies rate-limit errors as `'error'` | High | `providers/tracked.js` |
| 2 | No `RETRY` status / `next_retry_at` for rate-limited jobs | High | `db/schema.js`, `pipeline/runner.js` |
| 3 | QuotaGuardService ignores `provider_rate_limits` table | High | `services/quotaGuardService.js` |
| 4 | Input hash not normalized (ordering, whitespace) | Medium | `lib/callProvider.js` |
| 5 | Pipeline stages bypass `callProvider()` (8 files) | High | 8 stage files + `providers/registry.js` |
| 6 | No batch keyframes for Vision (analyze stage) | Medium | `stages/summaryAnalyze.js` |
| 7 | Hardcoded `CONTEXT_WINDOW_SEC` and `FRAME_FPS` | Medium | `stages/dubTranslate.js`, `stages/dubOcr.js` |
| 8 | No `GET /providers/:provider/quota` endpoint | Medium | `routes/v1/providers.js` |
| 9 | ApiKeys: no label/priority/tier in form, no quota display | Medium | `pages/ApiKeys.jsx`, `routes/v1/apiKeys.js` |
| 10 | No free-tier wizard warning | Low | `pages/CreateProject.jsx` |
| 11 | No quota_risk/retry UI in Queue/ProjectDetail | Medium | `pages/Queue.jsx`, `pages/ProjectDetail.jsx` |
| 12 | No `.env.example` | Low | `.env.example` (new) |
| 13 | No `PROV_002` error code for exhausted keys | Low | `providers/registry.js` |

---

## Design

### 1. `tracked()` Rate-Limit Classification

**File:** `backend/src/providers/tracked.js`

Add `isRateLimitError()` helper (same logic as `callProvider.js`):
```js
function isRateLimitError(err) {
  if (err.name === 'RateLimitExhaustedError') return true
  const msg = (err.message || '').toLowerCase()
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')
    || msg.includes('insufficient_quota') || msg.includes('retry-after')
}
```

In the catch block of `tracked()`, classify status:
```js
const status = isRateLimitError(err) ? 'rate_limited' : 'error'
```

### 2. Pipeline Retry Logic for Rate-Limited Jobs

**Files:** `db/schema.js`, `pipeline/runner.js`

#### Schema change
Add `next_retry_at` column to `generation_jobs`:
```js
try { db.run(`ALTER TABLE generation_jobs ADD COLUMN next_retry_at TEXT`) } catch (_) {}
```

#### Runner changes

In `executeStage()`, when catching errors:
- If `isRateLimitError(err)`:
  - Calculate `nextRetryAt`:
    - Parse `Retry-After` header from error if available
    - Otherwise: calculate next RPM/RPD reset from `provider_rate_limits`
  - Set `job.status = 'retry'`, `job.next_retry_at = nextRetryAt`
  - Publish SSE: `{ stage, status: 'retry', nextRetryAt }`
  - Do NOT mark as `failed`
- If regular error: existing `failJob()` logic (marks `failed` after max attempts)

In `executeStage()`, before running a stage:
```js
if (job.status === 'retry' && job.next_retry_at) {
  const retryAt = new Date(job.next_retry_at)
  if (Date.now() < retryAt.getTime()) {
    // Not ready yet — skip this stage, pipeline will re-check on next tick
    return true // don't mark as failed
  }
}
```
The `drainQueued` worker or the next pipeline invocation will pick up the job when the retry window opens.

Max retry attempts for rate-limited errors: **5** (vs 3 for regular errors).

### 3. QuotaGuardService Fix

**File:** `backend/src/services/quotaGuardService.js`

`getQuotaSnapshot()` — Query actual limits:
```js
const limit = await queryOne(
  `SELECT * FROM provider_rate_limits 
   WHERE provider = ? AND (user_id = ? OR user_id IS NULL) 
   ORDER BY user_id DESC LIMIT 1`,
  [provider, userId]
)
const limitToday = limit?.requests_per_day || null
const limitThisMinute = limit?.requests_per_minute || null
```

`percentUsed` calculation:
```js
const pctDaily = limitToday ? usedToday / limitToday : 0
const pctMinute = limitThisMinute ? usedThisMinute / limitThisMinute : 0
const percentUsed = Math.max(pctDaily, pctMinute)
```

Add `estimatedShortfall` to warning:
```js
const estimatedShortfall = estimatedRequestsNeeded - (limitToday - usedToday)
```

### 4. Input Hash Normalization

**File:** `backend/src/lib/callProvider.js`

Replace `inputHash()` with normalized version:
```js
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

### 5. Pipeline Stages → `callProvider()`

**8 stage files** — Replace `tracked(meta, fn)` with `callProvider({...})`.

Each stage needs:
- `userId` from `project.user_id`
- `apiKeyId` from provider resolution (new field in `getProvider()` return)

**`providers/registry.js`** — Extend return value:
```js
return { id: providerId, provider: factory(apiKey), apiKeyId: keyRow?.id || null }
```

Stage migration pattern:
```js
// Before:
const described = await tracked(
  { projectId: project.id, jobId: job.id, provider: vision.id, type: 'vision' },
  () => vision.provider.describeImage({ imagePath: thumbPath })
)

// After:
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

### 6. Batch Keyframes for Vision

**File:** `backend/src/pipeline/stages/summaryAnalyze.js`

Group keyframes into batches of 5:
```js
const BATCH_SIZE = 5
for (let i = 0; i < keys.length; i += BATCH_SIZE) {
  const batch = keys.slice(i, i + BATCH_SIZE)
  const thumbPaths = await Promise.all(batch.map(scene => {
    const thumbPath = path.join(thumbsDir, `${scene.id}.jpg`)
    return makeThumbnail(src, (scene.start_sec + scene.end_sec) / 2, thumbPath).then(() => thumbPath)
  }))
  
  const described = await callProvider({
    provider: vision.id,
    type: 'vision',
    model: vision.provider.model || vision.id,
    input: { imagePaths: thumbPaths },
    fn: () => vision.provider.describeBatch?.({ imagePaths: thumbPaths })
      || Promise.all(thumbPaths.map(p => vision.provider.describeImage({ imagePath: p }))),
    userId: project.user_id,
    apiKeyId: vision.apiKeyId,
    projectId: project.id,
    jobId: job.id,
  })
  // Process results...
}
```

Note: If Vision provider supports multi-image input (Gemini, GPT-4o), use native batch. Otherwise, call `describeImage()` sequentially within a single `callProvider()` call — this still provides caching and rate-limit benefits for the batch as a whole.

### 7. Tier-Based Config

**File:** `backend/src/pipeline/stages/dubTranslate.js`

Make `CONTEXT_WINDOW_SEC` tier-aware:
```js
// Query tier from api_keys or provider_rate_limits
const tier = params.tier || 'free'
const CONTEXT_WINDOW_SEC = tier === 'free' ? 45 : 30  // wider window = fewer LLM calls
```

**File:** `backend/src/pipeline/stages/dubOcr.js`

Make `FRAME_FPS` tier-aware for cloud OCR:
```js
const isCloudOcr = ocr.id !== 'tesseract'
const FRAME_FPS = isCloudOcr ? (Number(process.env.OCR_SAMPLE_FPS) || 0.5) : 2
```

### 8. `GET /providers/:provider/quota` Endpoint

**File:** `backend/src/routes/v1/providers.js`

Add endpoint:
```js
router.get('/:provider/quota', async (req, res) => {
  const snapshot = await getQuotaSnapshot(req.user.id, req.params.provider)
  res.json(snapshot)
})
```

### 9. ApiKeys Page Enhancements

**File:** `frontend/src/pages/ApiKeys.jsx`

- Add form fields: `label` (text), `priority` (number 0-10), `tier` (select: free/paid/custom)
- Show per-key quota bar (RPM/RPD usage from `/providers/:provider/quota`)
- Allow multiple keys per same provider

**File:** `backend/src/routes/v1/apiKeys.js`

- `POST /` accepts `tier`, `priority` fields
- `PUT /:id` supports updating `tier`, `priority`
- `GET /` returns `tier`, `priority` fields

### 10. Free-Tier Wizard Warning

**File:** `frontend/src/pages/CreateProject.jsx`

After provider selection, if provider tier is `free` and estimated content is long:
- SUMMARY mode > 60 min → warning banner
- TRANSLATE_DUB mode > 20 min → warning banner

Soft warning only, doesn't block submit.

### 11. Queue/ProjectDetail Retry UI

**Files:** `frontend/src/pages/Queue.jsx`, `frontend/src/pages/ProjectDetail.jsx`

- Job `status: 'retry'` → show clock icon + "Đang chờ quota hồi phục lúc HH:mm"
- Job `result.warnings` contains `quota_risk` → yellow warning icon
- SSE handling for `retry` status events

### 12. `.env.example`

Create `backend/.env.example` with documented rate-limit vars:
```
PROVIDER_RATE_LIMIT_SAFETY_MARGIN=0.8
PROVIDER_CACHE_ENABLED=true
PROVIDER_CACHE_TTL_DAYS=90
QUOTA_WARNING_THRESHOLD=0.8
DEFAULT_PROVIDER_MODE=live
OCR_SAMPLE_FPS=0.5
```

### 13. `PROV_002` Error Code

**File:** `backend/src/providers/registry.js`

Add error code for exhausted keys:
```js
export class ProviderError extends Error {
  constructor(message, code = 'PROV_001') {
    super(message)
    this.code = code
  }
}

// PROV_002: All keys for a provider exhausted
```

---

## Testing Strategy

- Unit tests for `normalizeInput()` and `inputHash()` equivalence
- Unit tests for `getQuotaSnapshot()` with mocked DB
- Integration test for `callProvider()` cache + rate limit flow
- Verify pipeline stages properly use `callProvider()`
- Frontend: manual test of ApiKeys form, wizard warning, Queue retry display

---

## Files Changed (Summary)

| File | Change Type |
|------|-------------|
| `providers/tracked.js` | Modify — rate_limited classification |
| `db/schema.js` | Modify — add `next_retry_at` column |
| `pipeline/runner.js` | Modify — retry logic for rate-limited jobs |
| `services/quotaGuardService.js` | Modify — read from provider_rate_limits |
| `lib/callProvider.js` | Modify — input hash normalization |
| `providers/registry.js` | Modify — return apiKeyId, PROV_002 |
| `pipeline/stages/summaryAnalyze.js` | Modify — batch keyframes, use callProvider |
| `pipeline/stages/summaryScript.js` | Modify — use callProvider |
| `pipeline/stages/summaryAlign.js` | Modify — use callProvider |
| `pipeline/stages/summaryTranscribe.js` | Modify — use callProvider |
| `pipeline/stages/dubStt.js` | Modify — use callProvider |
| `pipeline/stages/dubOcr.js` | Modify — use callProvider, tier-aware fps |
| `pipeline/stages/dubTranslate.js` | Modify — use callProvider, tier-aware window |
| `pipeline/stages/dubTtsAlign.js` | Modify — use callProvider |
| `providers/vision/geminiVision.js` | Modify — add describeBatch() |
| `routes/v1/providers.js` | Modify — add quota endpoint |
| `routes/v1/apiKeys.js` | Modify — accept tier/priority |
| `pages/ApiKeys.jsx` | Modify — label/priority/tier form + quota display |
| `pages/CreateProject.jsx` | Modify — free-tier warning |
| `pages/Queue.jsx` | Modify — retry/quota_risk display |
| `pages/ProjectDetail.jsx` | Modify — retry/quota_risk display |
| `lib/constants.jsx` | Modify — add RETRY status label |
| `.env.example` | New |
