# VIDEO-AI — ROOT CAUSE ANALYSIS & DIAGNOSTICS: QUOTA, TRANSLATION & DUBBING RELIABILITY

**Audit Date:** 2026-10-31  
**Auditor Role:** Senior Backend Engineer (AI media pipelines, distributed jobs, LLM orchestration, speech processing, video rendering)  
**Target Repository:** `D:\E\Video_AI`  
**Execution Context:** Production & Development Pipeline Verification (PHASE 1 AUDIT)

---

## 1. Executive Summary & Git Preservation

### 1.1 Git Status & Change Preservation
- **Branch:** `main` (up to date with `origin/main`).
- **Uncommitted User Changes Protected:**
  - `backend/src/pipeline/stages/dubTranslate.js`
  - `backend/src/pipeline/translateQa.js`
  - `backend/src/providers/geminiClient.js` (Added per-request timeout & abort controller integration)
  - `backend/src/providers/llm/gemini.js`
  - `frontend/src/components/project/PipelineStatus.jsx`
  - `frontend/src/hooks/useJobEvents.js`
  - `frontend/src/lib/providerErrorMessage.js`
  - `frontend/src/pages/ProjectDetail.jsx`
- **Protection Evidence:** Git stash snapshot created (`18fa69c23c71d600cef89138e43df8c464bb9a3e`). All existing user uncommitted modifications remain fully intact.

---

## 2. End-to-End Pipeline Audit: Upload to FFmpeg Render

The complete pipeline executes sequentially across 7 core stages (for `TRANSLATE_DUB` mode):

```
1. dub.ingest      --> Media probe, audio extraction (source_norm.wav), loudness normalization.
2. dub.stt         --> Multi-chunk ASR/STT slicing (300s chunks, 15s overlap), language locking, hallucination & timing sanity checks.
3. dub.merge       --> Overlap deduplication, boundary stitching, database persistence to transcript_segments.
4. dub.translate   --> Multi-tier translation (LLM XML batch primary -> GT fallback -> tone restyle -> semantic QA validation gate).
5. dub.mask        --> Video hardsub subtitle OCR/bounding box detection & mask generation (AUTO_STATIC & MANUAL).
6. dub.ttsAlign    --> Segment synthesis with failover (ZeroTTS / EdgeTTS / OpenAI TTS), pause-expansion, native speed & tempo fitting.
7. dub.render      --> Hardsub masking (solid/blur) -> ASS burn-in -> voice timeline overlap verification -> FFmpeg ducking/muxing.
```

---

## 3. Investigation of Root Causes: Code Evidence & Findings

### 3.1 Problem 1: Gemini/API Quota Contention & 429/503 Storms
- **File / Functions:**
  - `backend/src/providers/geminiClient.js`: `generateContent()`
  - `backend/src/pipeline/stages/dubTranslate.js`: `translateMissingWithLlm()`, `translateGroup()`, `restyleGroup()`
  - `backend/src/lib/callProvider.js`: `executeProviderCall()`
- **Observed Symptoms:**
  - Intermittent 429 / `RESOURCE_EXHAUSTED` and 503 `High Demand` errors during translation.
- **Root Cause & Concrete Evidence:**
  1. **Multi-layer Nested Retry Storm:** `geminiClient.js` implements its own internal retry loop (`while (true)` up to `retryBudget = 5` with backoff). In addition, `dubTranslate.js` wraps batch execution in a retry loop (`for (attempt = 1; attempt <= 2)`), while `translateGroup()` also contains an inner attempt loop (`MAX_ATTEMPTS = 3`), and `runner.js` contains a stage-level retry policy (`RETRY_POLICY['dub.translate'] = 2`). When a 429 or 503 occurs, retrying simultaneously across 3-4 layers exponentially multiplies call pressure against the Gemini rate quota.
  2. **Concurrency Pressure on Shared Free-tier RPM:** `dubTranslate.js` dispatches batches with concurrency (`LLM_BATCH_CONCURRENCY = 2`). Although `rateLimit.js` implements a shared `SlidingWindow(rpm = 10)`, running 2 concurrent batch streams with retries can deplete free-tier tokens (15 RPM) rapidly.
  3. **Classification Distinction:** `providerErrors.js:101-105` distinguishes quota exhaustion (`PROVIDER_QUOTA_EXCEEDED`) from temporary rate limits (`PROVIDER_RATE_LIMITED`). When true quota is hit, `geminiClient.js` correctly classifies it as non-retryable for the same key, but repeated callers without cache check would trigger unnecessary lookups.

### 3.2 Problem 2: Translation Semantic Errors (Numbers, Negations, Proper Nouns, Inversion)
- **File / Functions:**
  - `backend/src/pipeline/stages/dubTranslate.js`: `validateTranslation()`, `hasHardTranslationError()`, `classifyTranslationErrors()`
  - `backend/src/pipeline/translatePrompt.js`: `buildSegmentTranslatePrompt()`
- **Observed Symptoms:**
  - Numbers changed (e.g. 3 -> 5), dropped negations (e.g. "I don't go" -> "Tôi đi"), dropped character names, hallucinated expansions.
- **Root Cause & Concrete Evidence:**
  1. **Prompt Context Bleed & Free-form Generation:** LLMs translating subtitles without rigid delimiters occasionally drop or invent numbers.
  2. **Soft vs Hard Classification in Code:** In `dubTranslate.js:HARD_EXACT` and `HARD_PREFIXES`, `number mismatch` and `untranslated copy` are classified as `HARD`, which blocks acceptance. However, `entity changed` is treated as a soft warning to prevent false positives when transliterating foreign names.
  3. **Repair Loop Enforcement:** When a semantic gate fails, `repairTranslationWithLlm()` attempts surgical single-line correction. If repair fails, the fallback mechanism (`resolveFinalTranslation()`) previously fell back to Google Translate without strictly verifying if GT preserved numbers. The recent patch added `baseGate.errors.every(...)` checks, but strict semantic gate enforcement requires rejecting unverified base segments.

### 3.3 Problem 3: STT Transcript & Timestamp Inaccuracies
- **File / Functions:**
  - `backend/src/pipeline/stages/dubStt.js`: `dubStt()`
  - `backend/src/pipeline/sttUtils.js`: `buildSttChunks()`, `dedupeOverlapSegments()`, `isHallucinatedText()`, `validateSttTiming()`
- **Observed Symptoms:**
  - Hallucinated repeating sentences during background music/silence; drifting timestamps across 300s chunk boundaries.
- **Root Cause & Concrete Evidence:**
  1. **Per-chunk Language Flipping:** Whisper without an explicit `language` parameter re-evaluates language per chunk. Silent chunks or musical interludes would flip to other languages, causing incorrect timestamps. `dubStt.js:52-53` addressed this by introducing `normalizeSttLanguage()` and locking `lockedLanguage` after initial detection.
  2. **Overlap Stitching Artifacts:** Chunks have 15s overlaps (`STT_OVERLAP_SEC = 15`). In `sttUtils.js:dedupeOverlapSegments()`, duplicate cues at boundary seams must match suffix-prefix tokens. Without strict fuzzy tolerance, word repetition occurs.

### 3.4 Problem 4: TTS Misreadings, Speaker Confusion & Slot Overshoot
- **File / Functions:**
  - `backend/src/pipeline/stages/dubTtsAlign.js`: `dubTtsAlign()`, `shortenTranslation()`
  - `backend/src/media/mediaService.js`: `buildDubTrack()`
- **Observed Symptoms:**
  - Audio exceeds subtitle slot; tempo sped up unnaturally (>1.5x) or voice chopped off.
- **Root Cause & Concrete Evidence:**
  1. **Slot Duration vs Vietnamese Syllable Length:** Vietnamese translations are typically 20-30% longer in syllable count than English or Chinese sources. When slot duration is short (e.g., 1.2s for 15 syllables), standard TTS synthesis generates audio that exceeds the slot.
  2. **Pause Expansion Mitigation:** `dubTtsAlign.js:115` calculates `roomDur = Math.max(slotDur, nextStart - 0.06 - start_sec)` to expand into natural conversational pauses rather than squeezing speech into unnatural chipmunk tempo (`SPEED_MAX = 1.35`).
  3. **Shortening Semantic Drift:** When shortening is invoked, `shortenTranslation()` must enforce `validateTranslation(sourceText, cleaned, targetLanguage).ok`. If this gate is bypassed, LLM shortening drops numbers or reverses negation.

### 3.5 Problem 5: Render Using Stale, Incomplete, or Out-of-Order Segments
- **File / Functions:**
  - `backend/src/pipeline/stages/dubRender.js`: `dubRender()`, `resolveAudioEntries()`
  - `backend/src/services/transcriptMutationService.js`: `getTranscriptSnapshot()`
- **Observed Symptoms:**
  - Audio voice desynchronization; rendering video when segments failed TTS.
- **Root Cause & Concrete Evidence:**
  1. **Array Index vs Explicit ID Mapping:** In older implementations, audio files were matched by array index (`i`), causing misalignment if any segment was skipped. `dubRender.js:140-195` enforces strict 1:1 mapping: `ts.id -> a.id -> seg_fit_<id>.wav`.
  2. **BLOCK_RENDER Gate Enforcement:** `dubRender.js:192-198` throws `BLOCK_RENDER: MISSING_TTS_AUDIO` if any required segment lacks physical voice audio. It also verifies chronological sequence: `entriesWithTts[i].offsetSec < entriesWithTts[i - 1].endAtSec - 0.05` throws `BLOCK_RENDER: OVERLAP`.

### 3.6 Problem 6: Redis & BullMQ Job Loops / Inconsistent Status
- **File / Functions:**
  - `backend/src/queue/connection.js`: `createRedisConnection()`, `enableOfflineQueue: false`
  - `backend/src/queue/projectQueue.js`: `safeAddProject()`
  - `backend/src/queue/workers/drainQueued.js`
- **Observed Symptoms:**
  - "Stream isn't writeable" error in BullMQ; projects stuck in `queued` indefinitely when Redis restarts.
- **Root Cause & Concrete Evidence:**
  1. **Shared Stream Contention:** Multiple BullMQ Queues and Workers sharing a single IORedis connection caused command buffer contention. `connection.js:createRedisConnection()` factory was introduced to provide isolated dedicated connections for ProjectQueue, CleanupQueue, and NotifyQueue.
  2. **Offline Queue False Recovery:** `enableOfflineQueue: false` is configured to fail fast rather than silently queueing unbounded memory commands during a Redis outage.

### 3.7 Problem 7: Unnecessary AI Invocations & Cache Misses
- **File / Functions:**
  - `backend/src/lib/callProvider.js`: `checkCache()`, `storeCache()`, `singleFlightKey()`
  - `backend/src/lib/ttsCacheKey.js`: `buildTtsCacheInput()`
  - `backend/src/lib/asrCacheKey.js`: `buildAsrCacheInput()`
- **Observed Symptoms:**
  - Re-running a failed job re-synthesizes all TTS and re-translates all lines from scratch.
- **Root Cause & Concrete Evidence:**
  1. **Cache Key Impurity:** When cache keys included ephemeral properties (such as local project temporary paths or execution timestamps), content-addressable lookups missed.
  2. **Resolution:** Canonical cache fingerprints (`ttsClipKey` based on `{ provider, voice, text, speed }` and `asrCacheKey` based on streaming audio content SHA-256) ensure stable cache hits across project runs.

---

## 4. Phase 2-7 Implementation Blueprint & Recommendations

1. **Quota Control:** Standardize retry budgets: stage-level retries should delegate to provider failover rather than nested loops.
2. **Translation Quality:** Enforce zero-tolerance for number and negation mutations; maintain glossary lock for character names and technical terms.
3. **Incremental Execution:** Guarantee that edited or completed segments are skipped during regeneration using `is_translation_manually_edited` and `tts_clip_key` reuse.
4. **Testing Suite:** Maintain full test coverage across 429 backoff, 503 failover, Redis disconnection guards, and semantic translation gates.
