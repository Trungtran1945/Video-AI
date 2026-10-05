# BÁO CÁO TỔNG HỢP HOÀN CHỈNH — TTS Cache Isolation + ZeroTTS Hardening + Failover (task.txt)

**Ngày:** 2026-10-05 (UTC+07)
**Nhiệm vụ gốc:** `Video_AI_docs/task.txt` (HEAD `6003ef9`) — 13 mục tiêu: chặn cross-project TTS artifact reuse, hardening ZeroTTS, sửa failover dedupe + aggregate retryability, giữ backward-compat pipeline.
**Đầu vào đã đọc:** `.team/PLAN.md`, `.team/BACKEND_REPORT.md`, `.team/FRONTEND_REPORT.md`, `.team/TEST_REPORT.md` + `git status` / `git diff --stat` / `git log` trên nhánh `main`.
**Lưu ý trung thực (quan trọng):** `.team/TEST_REPORT.md` thuộc **chu kỳ cũ** (nửa đầu: chu kỳ docs-sync 128 files + bug `confirmPreview` "chờ duyệt"; nửa sau "Đợt 2": chu kỳ quota/preview 130 files + defect orphan handler FE-01; §2 của nó còn ghi `FRONTEND_REPORT.md NOT FOUND`). Các số liệu kiểm thử **mới nhất của chu kỳ hiện tại** lấy từ `BACKEND_REPORT.md` + `FRONTEND_REPORT.md` (ngày 2026-10-05, đúng scope working tree). Turn này tôi **không chạy lại suite** — chỉ đọc reports + kiểm chứng git; mọi con số PASS đều ghi rõ nguồn. Không commit/push (đúng Git Rules).

---

## 1. Tóm tắt kết quả nhiệm vụ

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| **Kế hoạch** | Xong — `.team/PLAN.md` (160 dòng). Chốt mapping 13 mục tiêu → module, thứ tự P0 trước P1, whitelist file, gates QA-CACHE/SF/BP/LIMIT/FS/MP3/TO/FO/CH/OBS/REG/FE | `.team/PLAN.md` |
| **Backend** | Xong BE-C01→C06, BE-Z01→Z08, BE-F01→F03, BE-D01→D03. 8 files sửa + 3 files mới, 0 file xóa | `.team/BACKEND_REPORT.md` + `git status/diff` (khớp) |
| **Frontend** | Xong FE-01→FE-04. 6 files sửa, 0 thêm/0 xóa; lint/typecheck/build PASS | `.team/FRONTEND_REPORT.md` |
| **Kiểm thử** | Mới nhất (từ team reports): backend **132 files PASS** (130 cũ + 2 mới), 2 suites mới ALL PASS; frontend 3 gates PASS. `TEST_REPORT.md` hiện tại **stale** — chưa có kết quả cho chu kỳ này | §4 (ghi rõ nguồn từng con số) |
| **Git** | Nhánh `main`, HEAD `b3f0750`, up-to-date. 14 files `M` + 4 untracked. Không commit/push | `git status`, `git log` (§2.1) |

**Kết luận 1 dòng:** Mọi mục P0/P1 trong `task.txt` đã được hiện thực trên working tree (cache isolation, ZeroTTS admission/limits/fs-jail/fail-closed-MP3/observability/shutdown, failover dedupe + aggregate, Docker service + CI job riêng, error mapping frontend); tồn đọng xác thực: ZeroTTS live E2E với model thật **NOT_VERIFIED** (chờ CI `zerotts-e2e`), Redis local DOWN (expected), vài lỗi lint có sẵn ngoài phạm vi.

---

## 2. Chi tiết các thay đổi Backend

> Nguồn: `.team/BACKEND_REPORT.md` + `git status` / `git diff --stat` (đã đối chiếu — khớp).

### 2.1. Trạng thái git thực tế (đã kiểm chứng lúc tổng hợp)

- Branch `main`, HEAD `b3f0750 feat(quota,preview): warn-only precheck, priority key failover, DB rate limits, quota UX and preview confirm` (mới hơn HEAD `32a8954` mà `REPORT.md` cũ ghi — các commit quota/preview đã vào `main`).
- 14 files modified, **972 insertions(+) / 140 deletions(−)**:
  - CI/Docker (2): `.github/workflows/ci.yml` (+41), `docker-compose.yml` (+32)
  - Backend (6): `backend/scripts/zerotts_service.py` (+536/−nhiều), `backend/src/config.js` (+19), `backend/src/lib/callProvider.js` (+93), `backend/src/lib/providerFailover.js` (+50), `backend/src/pipeline/stages/dubTtsAlign.js` (+8), `backend/src/providers/tts/zeroTts.js` (+77)
  - Frontend (6): `frontend/src/api/extra.js` (+1), `frontend/src/components/project/PipelineStatus.jsx` (+55), `frontend/src/lib/constants.jsx` (+3), `frontend/src/lib/providerErrorMessage.js` (+79), `frontend/src/pages/ProjectDetail.jsx` (+96), `frontend/src/pages/ProviderSettings.jsx` (+22)
- Untracked (4): `Video_AI_docs/task.txt`, `backend/tests/providerCacheIsolation.test.mjs`, `backend/tests/providerFailoverAggregate.test.mjs`, `docker/zerotts.Dockerfile`.
- Deleted: none. Không chạm: `.env`, `data.db`, `storage/*`, enum status, STT/translation/alignment/resume/SSE/upload/cleanup/sql.js single-writer.
- Lưu ý: `.team/` bị gitignore (commit `0b93c88`) nên docs team không hiện trong `git status` — bình thường.

### 2.2. Nhóm CACHE — tách computation khỏi artifact (P0)

- **`backend/src/lib/callProvider.js`** (BE-C01→C05): comment contract mới (shared computation vs project artifact); single-flight key gồm `projectId` → waiter khác project không nhận `audioPath` lạ (đánh đổi có chủ ý: trùng input đồng thời synth 2 lần — an toàn hơn dedupe sai; bytes-based sharing là future work); helpers `localArtifactPath` / `isUnsafeCachedArtifact`; đọc cache: stale (file mất) → DELETE entry + MISS, cross-project (path ngoài owner dir) → MISS nhưng KHÔNG delete (giữ entry owner gốc), `projectId=null` (tests/legacy) giữ hành vi cũ; propagate `cacheHit` (DB-hit `true`, execution `false`, không persist flag).
- **`backend/src/pipeline/stages/dubTtsAlign.js`** (+8, BE-C01/C04): comment contract — filesystem resume (`clip_<hash>.mp3` + `probe > 0.05`) là project-local, giữ nguyên logic; DB `provider_cache` chỉ là computation cache; ownership = `audios` + `transcript_segments.tts_clip_key`.
- **Test mới `backend/tests/providerCacheIsolation.test.mjs`** (BE-C06): concurrent A+B, legacy unsafe, cacheHit — báo cáo ALL PASS (11 asserts).

### 2.3. Nhóm ZEROTTS — Python service + Node client (P1)

- **`backend/scripts/zerotts_service.py`** (+536, BE-Z01→Z05/Z07/Z08): admission semaphore (`MAX_INFLIGHT` default 8, non-blocking → vượt là `429 QUEUE_FULL`; inference `model_lock` timeout 120s → `503 SERVER_BUSY`); check `Content-Length` trước `read()` (thiếu → 400, vượt `MAX_BODY_BYTES=64KB` → 413; text vượt `MAX_TEXT_CHARS=2000` → 413); validate `THREADS 1..64 / CONCURRENCY 1..16 / MAX_INFLIGHT 1..64` fail-fast (exit 2); `OUTPUT_ROOT` jail (reject traversal/absolute ngoài root/symlink escape, `mkdir` chỉ trong root); MP3 fail-closed (FFmpeg missing/convert fail/ffprobe sai → `500 SYNTHESIS_ERROR` + xóa partial, bỏ `except: pass`); `/health` thêm `queueDepth/activeRequests/activeInference/started/completed/failed/abandoned/maxInflight/stopping`; `SIGTERM/SIGINT → STOPPING → reject new → drain bounded (SHUTDOWN_TIMEOUT_MS=15s)`; `finally` luôn release admission + inference slot.
- **`backend/src/providers/tts/zeroTts.js`** (+77, BE-Z05/Z06): bỏ fallback copy WAV→`.mp3`; `assertRealMp3` (reject RIFF + ffprobe `format_name` chứa mp3) trước return, fail → throw `PROVIDER_UNAVAILABLE`/`PROVIDER_RESPONSE_MALFORMED`; map 429/QUEUE_FULL → `RATE_LIMITED`, 413 → `INVALID_REQUEST`; document speed contract (ZeroTTS native không hỗ trợ speed → FFmpeg tempo downstream; giữ `supportsNativeSpeedFor` Edge/OpenAI).
- **`backend/src/config.js`** (+19, BE-D01): thêm `config.zerotts` tập trung env (document, không throw lúc boot).

### 2.4. Nhóm FAILOVER (P1)

- **`backend/src/lib/providerFailover.js`** (+50, BE-F01/F02): dedupe-trước-slice (`A:key1,A:key1,B:key2` maxAttempts=2 → thử `A:key1,B:key2`); `classifyAggregateFailover` (`ALL_TRANSIENT/ALL_QUOTA/ALL_AUTH/ALL_PERMISSION/ALL_CONFIGURATION/MIXED`); `retryable` aggregate (transient → true; quota/auth/permission/config → false; mixed → false + classification); per-attempt `{provider,apiKeyId,code,kind,retryable,attempt}`; giữ code `NO_PROVIDER_AVAILABLE` + message slice 300 (không leak secrets).
- **Test mới `backend/tests/providerFailoverAggregate.test.mjs`** (BE-F03) — báo cáo ALL PASS (13 asserts).

### 2.5. Nhóm DOCKER/CI/DOCS

- **`docker-compose.yml`** (+32, BE-D02) + **mới `docker/zerotts.Dockerfile`** (python:3.11-slim + ffmpeg + locked `onnxruntime/numpy/soundfile` + healthcheck): service `zerotts` riêng, `api` dùng `ZEROTTS_URL=http://zerotts:5005`, không expose public port mặc định. `docker compose config --quiet` báo cáo **PASS**.
- **`.github/workflows/ci.yml`** (+41, BE-D03): job `zerotts-e2e` riêng (Python + FFmpeg + locked deps + model cache + `npm run test:zerotts`); giữ `npm test` nhẹ; không coi SKIPPED là PASS.

---

## 3. Chi tiết các thay đổi Frontend

> Nguồn: `.team/FRONTEND_REPORT.md` + `git diff --stat` (6 files — khớp).

- **FE-01 — `frontend/src/lib/providerErrorMessage.js`** (+79): `friendlyJobError` mở rộng — `SERVER_BUSY/QUEUE_FULL` (429/503) → "Máy chủ TTS đang bận, thử lại sau"; 413/`BODY_TOO_LARGE`/`TEXT_TOO_LONG` → "Văn bản quá dài"; giữ nguyên voice error (`Voice 'xyz' không tồn tại`) và `INVALID_TEXT`; phân loại aggregate (`ALL_TRANSIENT` → bận/tạm thời; `ALL_AUTH` → kiểm tra API Key; `ALL_PERMISSION` → quyền model; `ALL_CONFIGURATION`/`MODEL_NOT_FOUND` → cấu hình; `ALL_QUOTA` → hết quota; generic `NO_PROVIDER_AVAILABLE`/`MIXED` → tất cả không khả dụng). Nhận cả string và structured object.
- **FE-02 — `frontend/src/pages/ProviderSettings.jsx`** (+22) + **`frontend/src/api/extra.js`** (+1): `KEYLESS_PROVIDERS = {zerotts, edge_tts}`; badge "Local / Keyless" (ZeroTTS) và "Miễn phí" (Edge); helper `providersApi.zerottsHealth()` + hiển thị telemetry (model, `queueDepth`) khi có.
- **FE-03 — `frontend/src/components/project/PipelineStatus.jsx`** (+55) + **`frontend/src/pages/ProjectDetail.jsx`** (+96): badge `⚡ <n>` cacheHitCount trên stepper (đọc từ `job.result` stage `dub.ttsAlign`/`summary.tts`); banner lỗi stage thân thiện (root-cause qua `friendlyJobError`, nhãn retryable, nút retry); tab Thông số (DUB) thêm thẻ "Lồng tiếng & Tối ưu Cache" (`voiceProvider`, `cacheHitCount/dubbedCount`); giữ DB-authoritative (không suy diễn completed từ SSE closed).
- **FE-04 — `frontend/src/lib/constants.jsx`** (+3): thêm `STATUS_LABELS` `busy` / `server_busy` / `rate_limited`; giữ enum canonical `pending/queued/running/completed/failed/cancelled`.
- Giữ dark theme `#0F1117`, không thêm SDK/BaaS, chỉ gọi REST qua `src/api/client.js`. Không đụng `components/timeline/` CapCut.

---

## 4. Báo cáo kiểm thử & độ tin cậy

### 4.1. Chu kỳ hiện tại (nguồn: BACKEND_REPORT + FRONTEND_REPORT, 2026-10-05)

| Gate | Kết quả (nguồn) | Ghi chú |
|---|---|---|
| Backend regression `cd backend; npm test` | **ALL TEST FILES PASS — 132 files** (130 cũ + 2 mới), gồm SKIP có chủ ý `zeroTtsIntegration` (decoupled, cần model ~900MB) — `BACK.../dev/null` | Chạy bởi Backend agent |
| `providerFailoverAggregate.test.mjs` | **ALL PASS** (13 asserts: dedupe, ALL_TRANSIENT/QUOTA/MIXED, helper) | Mới |
| `providerCacheIsolation.test.mjs` | **ALL PASS** (11 asserts: execution cacheHit:false, cross-project MISS, concurrent file riêng, same-project DB-hit true) | Mới |
| `providerFailover`, `providerQuotaClassification`, `providerErrors`, `ttsCacheResume`, `callProvider.cacheArtifacts`, `zeroTtsProvider` | **ALL PASS** (backward-compat giữ: stale→MISS, remote URL HIT) | Regression liên quan |
| Backend `npm run lint` (files đã chạm) | **0 error** (+1 eslint-disable cho legacy helper) | Full lint còn **3 pre-existing ngoài phạm vi** — không sửa theo surgical |
| `docker compose config --quiet` | **PASS** | BE-D02 |
| Python `py_compile zerotts_service.py` | **PASS** | Live model E2E NOT_VERIFIED (chưa pull model local; chờ CI) |
| Frontend `npm run lint` | **PASS** (0 warnings/errors) | `FRONTEND_REPORT §4` |
| Frontend `npm run typecheck` | **PASS** (0 errors) | `tsc -p ./jsconfig.json` |
| Frontend `npm run build` | **PASS** (2201 modules, ~4.36s) | Vite production bundle OK |
| Error-mapping assertions (SERVER_BUSY/QUEUE_FULL/413/VOICE/aggregates) | **PASS 100%** | Unit assertions trong FRONTEND_REPORT |
| Contract FE↔BE | **Không đổi** method/path/payload; health chỉ thêm fields additive | Không vỡ UI cũ |

### 4.2. Baseline môi trường (2 reports khớp nhau)

Node **v24.14.1** / npm **11.11.0**; Python **3.12.0** + `import zerotts` OK; FFmpeg **9.0.1-full_build-www.gyan.dev** (trái ghi chú "NOT installed" cũ trong AGENTS.md); Redis `npm run check:redis` **FAIL expected** (ECONNREFUSED 127.0.0.1:6379, fallback in-process); `GET /health` live không probe trong turn này.

### 4.3. `TEST_REPORT.md` stale — đối chiếu để tránh lẫn số liệu

- Đợt 1 trong file đó: suite **128 files** (127 PASS + 1 SKIP), backend lint **4 errors** — thuộc chu kỳ docs-sync cũ.
- "Đợt 2" trong file đó: suite **130 files** (quota tests), defect **orphan handler FE-01** (`handleConfirmPreview` không render trong JSX) — thuộc chu kỳ quota/preview đã commit (`b3f0750`); turn này tôi không verify lại điểm này trên code mới (`ProjectDetail.jsx` working tree +96 dòng TTS telemetry có thể đã khác) → **cần QA xác nhận lại**, không tự kết luận đã fix hay còn lỗi.
- Số lint "4 errors" (TEST_REPORT) vs "3 pre-existing" (BACKEND_REPORT) lệch nhau do khác thời điểm/scope đếm — cả hai đều thống nhất: lỗi có sẵn, ngoài phạm vi, cần task lint-fix riêng.

### 4.4. Tồn đọng & rủi ro thực sự còn lại

1. **ZeroTTS live E2E NOT_VERIFIED local** (QA-BP/LIMIT/FS/MP3/TO/OBS với model thật) — chờ CI job `zerotts-e2e`. Không tuyên bố hoàn thành tuyệt đối trước khi job này xanh.
2. **Last-writer-wins** provider_cache: 2 project trùng input ghi cùng row → project ghi sau thắng, project kia MISS lần sau (an toàn, tốn 1 synth dư). Fix triệt để = bytes-based cache (future work).
3. Strip path khi store chưa triệt để (giữ backward-compat + filesystem resume) — đã bù bằng ownership check khi đọc.
4. Redis DOWN → mọi path queue/cleanup chỉ verified qua mock/unit.
5. `Video_AI_docs/task.txt` untracked có sẵn + 3–4 lint pre-existing — ngoài phạm vi, để owner quyết.

---

## 5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng

### 5.1. Chạy local

```powershell
# Terminal 1 — backend trước
cd backend; npm run dev        # API http://localhost:3001 (/api/v1)
# Terminal 2 — frontend sau
cd frontend; npm run dev       # UI (Vite proxy /api + /storage → localhost:3001)
# ZeroTTS service (riêng, khi cần giọng local)
cd backend; npm run zerotts:start
# Queue đầy đủ (tùy chọn): docker compose up redis
```

### 5.2. Trải nghiệm thay đổi mới (khuyên dùng provider `mock` cho pipeline, ZeroTTS local khi test giọng)

1. **Cache isolation:** tạo 2 project TRANSLATE_DUB cùng câu text/voice → mỗi project có `clip_*.mp3` riêng dưới `audio_segments/` của mình; badge `⚡ <n>` hiện trên stepper khi có cache hit (tab Thông số → thẻ TTS).
2. **Backpressure:** set `ZEROTTS_CONCURRENCY=1`, bắn N request song song → request vượt trả `429 QUEUE_FULL` / `503 SERVER_BUSY`, UI hiện "Máy chủ TTS đang bận, thử lại sau" thay vì treo.
3. **Limits:** text > `ZEROTTS_MAX_TEXT_CHARS` (2000) → 413 + UI "Văn bản quá dài".
4. **Failover aggregate:** tắt ZeroTTS service → pipeline tự failover sang Edge/provider khác; hết quota mọi key → UI báo hết quota + gợi ý cấu hình provider khác (thay vì timeout trần).
5. **ZeroTTS keyless:** Settings → Providers → ZeroTTS badge "Local / Keyless" (không đòi API key), kèm model/queue depth khi service chạy.

### 5.3. Chạy lại kiểm thử

```powershell
cd backend; npm test                                  # full regression (~132 files)
node tests/providerCacheIsolation.test.mjs            # isolation + cacheHit
node tests/providerFailoverAggregate.test.mjs         # dedupe + aggregate
node tests/zeroTtsProvider.test.mjs                   # mock health/400/503/timeout/failover
npm run test:zerotts                                  # E2E nặng (cần Python + zerotts pkg + FFmpeg + model ~900MB)
cd ..\frontend; npm run lint; npm run typecheck; npm run build
docker compose config --quiet                         # PASS bắt buộc sau đổi compose
```

### 5.4. Việc tiếp theo đề xuất

1. Chờ/chạy CI job `zerotts-e2e` xanh rồi mới tuyên bố E2E hoàn tất (hiện NOT_VERIFIED local).
2. Refresh `.team/TEST_REPORT.md` cho chu kỳ này (bản hiện tại là 2 chu kỳ cũ) + xác nhận lại defect orphan handler FE-01 cũ còn/tắt.
3. Task lint-fix riêng cho 3–4 lỗi backend lint có sẵn.
4. Future work (đã ghi trong BACKEND_REPORT): bytes-based shared computation cache (hết last-writer-wins), bỏ `out_path` arbitrary khỏi public API ZeroTTS.
5. Cập nhật `Video_AI_docs/docs/03,05,08,11` + `README.md` (env ZeroTTS mới, cache-vs-artifact, admission, speed semantics) nếu Backend chưa làm trong turn docs.

---

## Verification stamp — quota accounting cycle (2026-10-06, append-only BE-R01)

- **verified SHA:** `dc5d152ea29c0bd61f27c403d23dbc4bf61c43ed` (HEAD lúc chạy verification; PLAN ghi baseline
  `b3f0750` nhưng repo đã ở `dc5d152` — chu kỳ TTS-cache trước đã vào `main`).
- **generated-at:** 2026-10-06 (UTC).
- **Scope chu kỳ này:** Quota Accounting Semantics + Failover Dedupe/Aggregate
  (`Video_AI_docs/task.txt` mới). Backend: `quotaGuardService.js` (accounting contract,
  status filter, daily/minute, warning scope, snapshot contract), `routes/v1/providers.js`
  (`GET /quota-summary`), `providerFailover.js` (Retry-After aggregate + docs),
  tests `quotaAccounting` + `quotaSummary` mới.
- **Verification:** `cd backend; npm test` → **ALL TEST FILES PASS — 134 files**
  (132 cũ + 2 mới `quotaAccounting`, `quotaSummary`); `docker compose config --quiet` → PASS;
  lint file chạm 0 error (3 pre-existing ngoài phạm vi). Chi tiết: `.team/BACKEND_REPORT.md`.
- **Lưu ý trung thực:** mọi nội dung phía TRÊN stamp này là **historical**
  (SHA `6003ef9`/`32a8954`/`b3f0750`) — không dùng làm evidence cho HEAD mới.
