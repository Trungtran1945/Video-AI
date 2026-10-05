# BÁO CÁO TỔNG HỢP HOÀN CHỈNH — Đồng bộ Docs ↔ Codebase Video_AI

**Ngày:** 2026-10-05 (UTC+07)
**Nhiệm vụ gốc:** Kiểm tra cấu trúc dự án và đồng bộ mô tả trong các file `.md` (`docs` / `Video_AI_docs/docs/`) sao cho đúng với project hiện có.
**Đầu vào đã đọc:** `.team/PLAN.md`, `.team/BACKEND_REPORT.md`, `.team/TEST_REPORT.md`, kiểm tra `git status` / `git diff` trên nhánh `main`.
**Lưu ý trung thực:** `.team/FRONTEND_REPORT.md` **không tồn tại** tại thời điểm tổng hợp (đã kiểm tra bằng `Test-Path`, kết quả `False`; QA report cũng ghi `NOT FOUND`). Mục Frontend dưới đây được tổng hợp từ `PLAN.md §3` + `TEST_REPORT.md §5–6` + kiểm tra `git diff -- frontend/` (trống), không bịa kết quả Frontend team.

---

## 1. Tóm tắt kết quả nhiệm vụ

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| **Kế hoạch** | Xong — `.team/PLAN.md` (146 dòng). Chốt nguyên tắc docs-as-mirror (code là truth, chỉ sửa `.md`), 16 gap G-01→G-16, tasks BE-01→BE-13 / FE-01→FE-07 / QA-00→QA-04, whitelist chỉ `.md` | `.team/PLAN.md` |
| **Backend (verify, không sửa code)** | Xong — `.team/BACKEND_REPORT.md`. Verify toàn bộ code-truth BE-01→BE-12, phát hiện 1 bug thật BE-13/FIX-OPT-01, giữ nguyên dirty tree có sẵn, không chạm `backend/*.js` | `.team/BACKEND_REPORT.md §3–5`, `git diff --stat` |
| **Frontend** | Báo cáo team thiếu (`FRONTEND_REPORT.md` NOT FOUND). Bù bằng QA kiểm độc lập: lint / typecheck / build PASS, contract FE↔BE PASS, `git diff -- frontend/` trống (không có thay đổi frontend) | `TEST_REPORT.md §2.3 + §5 + §6`, `git diff -- frontend/` (trống) |
| **Kiểm thử** | Xong — `.team/TEST_REPORT.md`. Backend 127 PASS / 1 SKIP / 0 FAIL (128 files), backend lint 4 errors có sẵn, frontend lint+typecheck+build PASS, Redis offline là expected, FFmpeg 9.0.1 sẵn sàng | `.team/TEST_REPORT.md §1, §4–6` |
| **Git** | Nhánh `main`, up-to-date với `origin/main`. Dirty tree có sẵn từ trước (không reset): 7 files `M`, untracked `.team/`, `backend/tests/sanitizeOverlaps.test.mjs`, `scripts/`, `team.ps1`. Không commit/push (đúng Git Rules) | `git status`, `git log --oneline -10` |

**Kết luận 1 dòng:** Nhiệm vụ khảo sát + kế hoạch + verify backend + kiểm thử đã hoàn thành với bằng chứng thực thi; tồn đọng duy nhất là thiếu `FRONTEND_REPORT.md` (đã bù bằng QA độc lập), 4 lỗi backend lint có sẵn, và 1 bug `confirmPreview` chờ duyệt riêng — không có gì chặn việc dùng docs-sync là truth tiếp theo.

---

## 2. Chi tiết các thay đổi Backend

> Nguyên tắc PLAN (Global Constraints + Phụ lục B): **không sửa logic code** trong đợt docs-sync; code là truth để sửa `.md` theo. Backend team đã tuân thủ — **0 file `.js` nào bị sửa trong turn báo cáo**; 7 files `M` dưới đây là dirty tree **có sẵn từ trước** (được ghi nhận nguyên văn trong cả BACKEND_REPORT và TEST_REPORT, không reset theo Git Rules).

### 2.1. Trạng thái git thực tế (đã kiểm chứng lúc tổng hợp)

- Branch `main`, `up to date with 'origin/main'`. 10 commits gần nhất từ `6003ef9` (ZeroTTS concurrency) trở về `a5514b7`.
- `git diff --stat`: **7 files changed, 143 insertions(+), 17 deletions(-)** — toàn bộ thuộc backend:
  - `backend/src/pipeline/runner.js` (+11/−~)
  - `backend/src/pipeline/stages/dubMerge.js`
  - `backend/src/pipeline/stages/dubTranslate.js`
  - `backend/src/providers/llm/gemini.js` (default model `gemini-3.6-flash` → `gemini-3.8-flash`)
  - `backend/src/providers/tracked.js` (+ cost entry `gemini-3.8-flash`)
  - `backend/src/providers/vision/geminiVision.js` (default model tương tự)
  - `backend/src/services/transcriptMutationService.js` (+100 dòng: hàm mới `sanitizeTranscriptOverlaps`)
- Untracked: `.team/` (3 files PLAN + BACKEND_REPORT + TEST_REPORT), `backend/tests/sanitizeOverlaps.test.mjs` (4.593 bytes), `scripts/`, `team.ps1`.
- `git diff -- frontend/`: **trống** — không có thay đổi frontend nào.

### 2.2. Nội dung code-truth đã verify (BE-01→BE-12, từ BACKEND_REPORT §3)

- **BE-01 prefix/health:** `backend/server.js:48` mount `/api/v1`; `GET /health` luôn 200 `{status, redis, bullmq, durableCleanup, cleanup, database+persistenceState, writes, auth.refreshFallback}`; `GET /ready` 200 / 503 theo `WRITE_BLOCKED` (`server.js:50-117`).
- **BE-02 routes đầy đủ:** auth×7, `PATCH /:id/segments/:segmentId/translation`, `POST /:id/translate-dub/confirm-preview (202)`, glossary GET/POST/DELETE, `GET /style-presets` (13 presets), settings GET/PUT, api-keys CRUD + `GET /providers/:provider/quota`, queue/analytics/providers/logs, admin users/providers/cleanup-tasks+retry, outputs+youtube POST/GET, legacy `POST /upload` + resumable `/uploads` (init/chunk?offset/complete + HEAD offset), masks CRUD, SSE ticket+events, generation start/redub/jobs/retry, transcript GET/PUT, timeline, cancel/regenerate/delete.
- **BE-03 auth/SSE/mask:** `?ticket=` single-use TTL 60s claim nguyên tử (`DELETE ... WHERE ticket_hash AND used=0 AND chưa hết hạn`, `auth.js:88-147`, `events.js:32-65`); `?token=` chỉ fallback deprecated; refresh cookie HttpOnly `Path=/api/v1/auth` SameSite Lax + fallback body/header deprecated (gỡ ở v2); CSRF cho refresh/logout; masks là CRUD `/masks`, không phải `mask-regions`.
- **BE-04 upload 8MB:** `CHUNK_SIZE=8MB`, `MAX_SIZE=2GB`, `express.raw 16mb`, `PUT /:id/chunk?offset=N` → 204 + `Upload-Offset`, `POST /:id/complete` → `{storageKey}`.
- **BE-05 idempotency/cancel/cleanup:** `Idempotency-Key` 1–128 ký tự/user TTL 7d + `409 IDEMPOTENCY_KEY_REUSE`, cleanup outbox sweep 60s + BullMQ hourly, cancel cooperative (+ `DELETE` khi running → 409), retention chỉ `completed/failed`, `cancelled` dọn ngay.
- **BE-06 stages (truth chốt cho docs):** `runner.js:224-243` — SUMMARY 8 `transcribe→sceneDetect→analyze→script→align→tts→subtitle→render`; DUB 6 sequential `[ingest],[stt+merge],[translate],[ttsAlign],[render]`; không `dub.ocr`, không song song.
- **BE-07 STT-only + redub:** `PATCH translation` + `POST redub` không chạy lại STT; confirm-preview 202.
- **BE-08 services:** đủ 9 services + 3 usecases (`create/cancel/confirmPreview`).
- **BE-09 queue/worker:** BullMQ 3 queues + drain 5s, workers in-process sau `waitForRedis(3000)`, prod fail-fast; **không worker container riêng** (`docker-compose.yml:66-70`, `redis:7-alpine` internal-only, `INSTANCE_MODE=single`, SQLite `/app/data/data.db`).
- **BE-10 providers:** `llm gemini/openai/mock`, `asr whisper/mock`, `tts zerotts/edge/elevenlabs/openai/google/mock`, `vision gemini/mock`, `translate google_translate`; NOT IMPLEMENTED: round-robin/cooldown, `safetyMargin`/`CACHE_TTL` bị bỏ qua, `quotaGuard` chỉ `GET /quota`, limiter in-memory; `selectBestApiKey` là dead code.
- **BE-11 schema:** 25 tables (`rg CREATE TABLE` = 25), `projects.mode SUMMARY|TRANSLATE_DUB`, status lowercase + migration `success→completed`, `generation_jobs UNIQUE(project_id,type)`, `transcript_segments` có `tts_clip_key/tts_duration_ms`, `ocr_regions DRAFT|APPROVED|DISABLED`; không `MediaConsent/MediaJob`.
- **BE-12 FFmpeg:** `resolveBin FFMPEG_PATH→PATH→C:\ffmpeg\bin`, `enqueue` chống crash -22, `SIGTERM→SIGKILL` 5s; timeout stage 15/30m (BURN 20m); NVENC chỉ burn subtitles; masks chỉ blur/boxblur/solid/drawbox; abort ở biên stage.

### 2.3. Nội dung dirty-tree có sẵn (để docs owner không nhầm là scope docs-sync)

Từ `git diff` thực tế (không phải do Backend team sửa): `sanitizeTranscriptOverlaps` mới trong `transcriptMutationService.js` (2-pass: gỡ duplicate chunk-boundary theo prefix CJK≥2/latin≥5 trong 1.0s + clamp overlap + renumber `index_num`, bump revision), được gọi từ `runner.js` (render-validation), `dubMerge.js`, `dubTranslate.js` (dọn trước dịch để khỏi QA `block_render` oan); nới `validateTranslation` CJK `maxHardRatio 12` (latin 8) vì câu ngắn CJK nở tới ~8.8x; default Gemini model lên `gemini-3.8-flash` (+ cost entry). Đây là context để sửa docs (`05`, `10`), không phải thay đổi cần review trong báo cáo này.

### 2.4. Bug thật duy nhất — FIX-OPT-01 (CHƯA SỬA, chờ duyệt)

- Vị trí: `backend/src/routes/v1/confirmPreview.js:9` chỉ có `requireProjectOwner`, thiếu `authMiddleware` → `projectAccess.js:29` đọc `req.user.id` gây TypeError (500 thay vì 401 khi thiếu token).
- Fix đề xuất (1 dòng): `router.post(..., authMiddleware, requireProjectOwner, ...)` + test 401 khi thiếu Bearer. Backend team cố tình chưa sửa theo surgical-changes; QA đã khoanh vùng lại tại `TEST_REPORT.md §6.4`.

---

## 3. Chi tiết các thay đổi Frontend

> `.team/FRONTEND_REPORT.md` không tồn tại nên mục này chỉ ghi những gì đã được QA kiểm độc lập + `git diff` trống. Không bịa tiến độ Frontend team.

- **Thay đổi code frontend: KHÔNG CÓ** — `git diff -- frontend/` trống; không file `frontend/src/*` nào ở trạng thái Modified.
- **Contract đã được QA đối chiếu PASS** (`TEST_REPORT.md §6`): Vite proxy `/api` + `/storage` → `http://localhost:3001`; `apiClient` baseURL `VITE_API_BASE || '/api/v1'`, Bearer memory-only + single-flight 401 → `POST /auth/refresh` retry 1 lần; endpoint mapping Auth/Projects/Masks (`/masks` CRUD, đã loại `mask-regions` cũ)/Upload resumable 8MB/presets+glossary khớp `backend/src/routes/v1/*`.
- **Việc docs-sync còn lại cho Frontend (từ PLAN §3, chờ docs owner thực hiện):** FE-01 bảng 18 routes (`App.jsx:57-81`, public 6 + protected 12 + `*`), FE-02 wizard `CreateProject` contract 2 modes, FE-03 `ProjectDetail` SSE ticket + fallback poll (DUB `transcript[]`, không còn `ocrRegions[]`), FE-04 inventory Shell/Auth-Visuals/Project/Timeline-CapCut + `ui/*` ~50 shadcn, FE-05 constants (`success→completed`, 13 preset slug, `auto/en/ja/ko/zh` → `vi/en`), FE-06 tokens dark `#0F1117` + chỉ gọi qua `api/client.js`, FE-07 contract table + ghi rõ `confirmPreview` đang orphan (BE xong, `ProjectDetail` chưa gọi) và `stylePresets catch→null`.
- **Hành động yêu cầu:** Frontend team bổ sung `.team/FRONTEND_REPORT.md` theo đúng cấu trúc BE (quyết định sửa/không sửa, route table đối chiếu `App.jsx`, contract `src/api/*.js`, gates đã chạy) để báo cáo tổng hợp kỳ sau không còn phải ghi bù.

---

## 4. Báo cáo kiểm thử & độ tin cậy

(Nguồn chính: `.team/TEST_REPORT.md` ngày 2026-10-05T17:11+07; Backend team xác nhận lại backend gates.)

### 4.1. Bảng gates

| Gate | Lệnh | Kết quả | Chi tiết |
|---|---|---|---|
| Baseline env | `node -v`, `npm -v`, `ffmpeg -version`, `npm run check:redis`, `git status` | PASS có ghi nhận | Node v24.14.1, npm 11.11.0, FFmpeg `9.0.1-full_build-www.gyan.dev` (gcc 16.1.0, `--enable-nvenc/x264/x265/whisper/cuda`) — khác ghi chú cũ "NOT installed" trong AGENTS.md, cần sửa docs |
| Redis | `cd backend; npm run check:redis` | FAIL / EXPECTED | `ECONNREFUSED 127.0.0.1:6379` — dev không bật Redis container; backend đúng spec chạy in-process không queue, prod fail-fast |
| Backend regression | `cd backend; npm test` (`node scripts/run-tests.mjs`) | **PASS — 127 PASS, 1 SKIP, 0 FAIL**, exit 0 | 128 files `*.test.mjs`; SKIP duy nhất `zeroTtsIntegration.test.mjs` (cần weights ~900MB, tách chủ đích qua `npm run test:zerotts`) |
| Backend lint | `cd backend; npm run lint` | FAIL (4 errors có sẵn) | `transcriptTiming.js:222 GAP unused`, `tts/zeroTts.js:218 ensureMp3Format unused`, `glossaryService.js:5 queryOne unused`, `zeroTtsIntegration.test.mjs:79 AbortSignal no-undef` — tồn đọng trước đợt docs-sync, cần task lint-fix riêng, không gộp |
| Frontend lint | `cd frontend; npm run lint` | PASS | exit 0, 0 error/warning |
| Frontend typecheck | `cd frontend; npm run typecheck` | PASS | `tsc -p jsconfig.json`, 0 lỗi |
| Frontend build | `cd frontend; npm run build` | PASS (4.38s) | `vite v6.4.3`, 2199 modules, `dist/index.html 0.84kB`, `CSS 121kB`, `JS 854kB (gzip 246kB)` |
| Frontend test suite | N/A | N/A đúng quy định | AGENTS.md: không có `frontend npm test`, không phát minh |
| Contract FE↔BE + proxy | Đối chiếu `frontend/src/api/*` ↔ `backend/src/routes/v1/*` + `vite.config.js` | PASS | Trừ 1 bug logic FIX-OPT-01 đã khoanh vùng (500 thay vì 401) |

### 4.2. Các bộ test trọng yếu đã pass

SSE `sseTicketRace` (100 req concurrent single-use claim nguyên tử) + `sseFallbackContract/RouteIntegration`; upload `uploadService/uploadComplete/uploadHttpContract/frontendUploadContract` (chunk 8MB, recovery, atomicity); transcript `transcriptMutationService/Revision/Atomic/HttpContract` (OCC/locking) + `redubUsesManual`; pipeline `pipelinePlan/Retry/dubTranslate.batch/dubMerge` + `translateValidate/Qa/ttsCacheResume/renderBlock/sttOverlapStitch` (mock, không cần FFmpeg thật); project `projectIdempotency/Admission/cancelStageGuard/heartbeatRecovery/queueLifecycle/deploymentSmoke`; mask `maskLifecycle/ApprovedImmutable/Render`; auth `csrfRefresh/refreshRotationRace/corsAllowlist/configProduction/seedProductionGuard`; DB/infra `persistenceAtomicity/Health/readinessState/safeMediaStatic/filesystemSecurity/cleanupDurability`.

### 4.3. Độ tin cậy & tồn đọng

- **Tin cậy cao:** regression 0 FAIL + frontend 3 gates PASS + contract PASS cho phép chốt docs-sync theo code-truth trong PLAN.
- **Tồn đọng诚实:** (1) thiếu `FRONTEND_REPORT.md`; (2) 4 backend lint errors có sẵn — tách task riêng; (3) Redis local offline — muốn test queue phải `docker compose up -d redis` hoặc overlay `redis-host.yml`; (4) FIX-OPT-01 chờ duyệt — mọi docs `06`/`03`/`04` khi mô tả `confirm-preview` phải ghi đúng hành vi thực (500 khi thiếu token) + cảnh báo sẽ fix.

---

## 5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng

### 5.1. Khởi động nhanh (backend trước, frontend sau)

```bash
# 1) Redis (bắt buộc nếu muốn test queue; không bật vẫn chạy in-process)
docker compose up -d redis
# Dev cần host access: docker compose -f docker-compose.yml -f docker-compose.redis-host.yml up

# 2) Backend
cd backend
npm install
npm run check:redis        # expect FAIL ECONNREFUSED nếu chưa bật redis — là bình thường ở dev
npm run dev                # http://localhost:3001 ; seed admin dev admin@asf.local/admin1234 + 13 style presets

# 3) Frontend (terminal mới)
cd frontend
npm install
npm run dev                # http://localhost:5173 (proxy /api + /storage → 3001)
```

Docker full-stack: `docker compose up -d --build` → app tại `http://localhost` (`web :80` proxy `/api` → `api:3001`); kiểm tra `http://localhost:3001/health` và `/ready`.

### 5.2. Kiểm lại báo cáo này (5 phút)

```bash
git status                 # expect: M 7 backend files (có sẵn) + ?? .team/ sanitizeOverlaps.test.mjs scripts/ team.ps1
git branch --show-current  # main
git diff --stat            # 7 files, 143+/17-
Test-Path .team/FRONTEND_REPORT.md   # hiện False — nhắc Frontend team bổ sung
cd backend; npm test       # expect ALL TEST FILES PASS (127 PASS/1 SKIP)
cd backend; npm run lint   # expect 4 errors có sẵn (đã liệt kê §4.1)
cd frontend; npm run lint; npm run typecheck; npm run build  # expect cả 3 PASS
```

### 5.3. Trải nghiệm tính năng theo docs-truth

- Tạo project: `/projects/new` — thử cả `SUMMARY` (video dài) và `TRANSLATE_DUB` (chọn 1/13 style, bật/tắt dubbing) → `POST /api/v1/projects`.
- Realtime: mở `/projects/:id` xem SSE progress (mất SSE → tự fallback poll `GET /projects/:id`); thử upload resumable file lớn (init → chunk `?offset=N` 8MB → complete → `storageKey`).
- Tinh chỉnh DUB: sửa câu dịch `PATCH /:id/segments/:segmentId/translation` → `POST /:id/translate-dub/redub` (không chạy lại STT); khoanh mask trên Canvas (`POST /:id/masks`); xem timeline CapCut tại `/timeline` demo.
- Không dùng `mask-regions` cũ hay `?token=` cũ — đã thay bằng `/masks` CRUD và `?ticket=` single-use.
- Cố tình gọi `POST /:id/translate-dub/confirm-preview` không token để tái hiện FIX-OPT-01 (hiện 500, sau fix phải 401) — đừng dùng làm gate chặn.

### 5.4. Việc tiếp theo đề xuất

1. Docs owner sửa `.md` theo gap G-01→G-16 (ưu tiên worker G-02, chunk 8MB G-03, ticket G-04, thứ tự stage G-05, enum lowercase G-07, masks/uploads G-09/G-10) rồi ghi `docs/superpowers/verify-docs-sync-<date>.md`.
2. Frontend team bổ sung `.team/FRONTEND_REPORT.md`.
3. Owner duyệt FIX-OPT-01 rồi mới sửa 1 dòng `confirmPreview.js` + test 401.
4. Tách task lint-fix cho 4 backend errors; không commit/push cho tới khi được yêu cầu rõ.
