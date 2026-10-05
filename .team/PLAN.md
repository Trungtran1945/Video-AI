# Kế hoạch Đồng bộ Docs ↔ Codebase Video_AI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) hoặc superpowers:executing-plans để thực hiện plan này task-by-task. Steps dùng checkbox (`- [ ]`) để tracking.

**Goal:** Đồng bộ toàn bộ file `.md` mô tả (README, AGENTS.md, `Video_AI_docs/docs/00–11`, `frontend/AGENTS.md`) sao cho khớp 100% với codebase hiện tại, không sửa logic code trừ bug chặn docs.

**Architecture:** Docs-as-mirror: lấy code làm truth (`backend/src/**`, `frontend/src/**`, `docker-compose.yml`, `package.json`), sửa docs theo code; mọi đề xuất đổi code tách thành task `FIX-OPT` riêng, không làm ngầm.

**Tech Stack:** Backend Node ≥18 ESM Express + sql.js + BullMQ/Redis + FFmpeg; Frontend React 18 + Vite 6 + TanStack Query v5; Docs Markdown trong `Video_AI_docs/docs/`.

**Spec:** Thư mục truth `Video_AI_docs/docs/` (12 file 00–11) + `README.md` + `AGENTS.md` + `frontend/AGENTS.md` + `docker-compose.yml`.

## Global Constraints

- Chỉ sửa `.md`, không refactor code ngoài phạm vi ghi rõ. Mọi chạm code phải surgical, giữ style hiện có.
- Không commit/push/merge khi chưa được yêu cầu rõ trong turn hiện tại; cấm `git reset --hard`, `git clean -fd`.
- Không log/ commit secrets (`.env`, API keys, tokens). Pipeline logs đã redacted.
- FFmpeg/Redis/DB: probe thực tế (`npm run check:redis`, `GET /health`, `ffmpeg -version`), không assume; ghi version thực vào báo cáo.
- Contract gate: `frontend/src/api/*` phải khớp `backend/src/routes/v1/*` sau mọi sửa docs API.
- Backend regression gate: `cd backend; npm test`. Frontend gate: `cd frontend; npm run lint` + `npm run build` (+ `typecheck`). Không phát minh `frontend npm test`.
- Giả định mặc định: code là đúng, docs là sai — trừ khi phát hiện bug code thì ghi `FIX-OPT` riêng, không sửa lén trong task docs.

---

## 1. Phân tích yêu cầu & Phạm vi (Scope)

### 1.1. Mục tiêu đã chốt

- [ ] **SCOPE-01 — Chốt định nghĩa "xong":** mọi câu trong docs mô tả sai đường dẫn, endpoint, enum, số liệu, thứ tự stage đều được sửa hoặc gắn nhãn `[TARGET]` / `[REMOVED]` rõ ràng; `README §5 + §8` khớp code; `10_TASKS.md` là truth về trạng thái DONE/PARTIAL/NOT IMPLEMENTED.
- [ ] **SCOPE-02 — Chốt ranh giới Không làm:** không migrate monorepo `apps/*`, không chuyển TS/Prisma/Postgres/S3, không thêm worker-per-stage, không hiện thực OCR/TransFlow song song, không đổi chunk size code — chỉ sửa chữ trong docs.
- [ ] **SCOPE-03 — Ghi baseline môi trường:** chạy `git status`, `git branch --show-current`, `git log --oneline -5`; probe `cd backend; npm run check:redis`, `GET /health`, `GET /ready`, `ffmpeg -version` (ghi SKIP/BLOCKED nếu thiếu kèm lý do); ghi Node/npm/Redis/FFmpeg version vào đầu báo cáo QA.

### 1.2. Gap matrix (code = truth, đã verify 2026-10-05)

| # | Docs sai / lệch | Truth trong code | File docs cần sửa |
|---|---|---|---|
| G-01 | `README §5` ghi `src/server.js`, `src/config.js` | Thực tế `backend/server.js`, `backend/src/config.js` | `README.md §5`, `01`, `03`, `08` |
| G-02 | `README §5` + `AGENTS.md` ghi worker `profile scale` | `docker-compose.yml:66-70` ghi rõ KHÔNG có worker riêng (in-process, sql.js single owner) | `README.md`, `AGENTS.md`, `01`, `08` |
| G-03 | Chunk size 3 số: docs `5–10MB`, `README` `16MB`, code `8MB` (`CHUNK_SIZE=8MB`, raw limit `16MB`) | `backend/src/services/resumableUploadService.js` + `src/routes/v1/upload.js` | `README §3`, `00`, `frontend/AGENTS.md`, `06` |
| G-04 | SSE ghi `?token=<JWT>` (`06 §2`) | Code + `README §8`: `POST /:id/sse-ticket` → `GET /:id/events?ticket=` single-use TTL 60s, claim nguyên tử | `06_API.md`, `03`, `04`, `frontend/AGENTS.md` |
| G-05 | Thứ tự SUMMARY stage đảo nhau (README vs AGENTS.md vs `05`) | `backend/src/pipeline/runner.js:224-243`: `summary.transcribe → sceneDetect → analyze → script → align → tts → subtitle → render`; DUB 6 stage sequential | `README §2.1`, `AGENTS.md`, `01`, `05` |
| G-06 | Mô tả `STT & OCR song song`, `dub.ocr`, `MediaConsent`, `MediaJob` | OCR đã REMOVED (STT-only), thay bằng `generation_jobs(type,step)`; không bảng `MediaConsent` | `00`, `01`, `02`, `03`, `05`, `10` đã đúng (lấy `10` làm chuẩn) |
| G-07 | Prisma enum UPPERCASE (`PENDING/SUCCESS`) vs code lowercase | `src/lib/projectStatus.js`: `pending/queued/running/completed/failed/cancelled` (+ legacy `success→completed`) | `02`, `06` (ghi rõ mapping) |
| G-08 | Đường dẫn TARGET `apps/api/*.ts`, `packages/core/*`, `apps/web/*.tsx` lẫn với CURRENT | CURRENT: `backend/src/**/*.js`, `frontend/src/**/*.jsx/js` | `01`, `03`, `04`, `07`, `09` (tách CURRENT/TARGET) |
| G-09 | `frontend/AGENTS.md` ghi `GET\|PUT /projects/:id/mask-regions` | Code: `GET/POST/PATCH/DELETE /projects/:id/masks[/:maskId]` (`masks.js`) | `frontend/AGENTS.md`, `04`, `06` |
| G-10 | `frontend/AGENTS.md` ghi upload `HEAD` + `POST /upload` cũ | Code: `POST /uploads/init` → `PUT /uploads/:id/chunk?offset=N` → `POST /uploads/:id/complete`; legacy `POST /upload` chỉ file nhỏ | `frontend/AGENTS.md`, `06` |
| G-11 | `09 §2` bảo backend "không có script lint" | `backend/package.json` có `lint: eslint src tests scripts --quiet` | `09_DONG_GOP.md` |
| G-12 | `06` thiếu extra `README §8`: `admin/cleanup-tasks`, retention sweep, `Idempotency-Key 409`, `cancel` cooperative, `GET /health` full shape + `GET /ready` 503 | `server.js:50-117`, `projects.js`, `admin.js`, `projectCleanup.js` | `06_API.md` (bổ sung từ README, lấy README+code làm chuẩn) |
| G-13 | `04` + `11` mô tả round-robin multi-key, `selectBestApiKey` | Code chỉ lấy key đầu; `selectBestApiKey` dead code; `callProvider` hardcode `rpm:10`, bỏ qua `provider_rate_limits` + `safetyMargin`/`CACHE_TTL` | `04`, `11`, `10` (đánh PARTIAL/NOT IMPLEMENTED) |
| G-14 | `confirm-preview` ghi `AUTH+OWNER` nhưng code thiếu `authMiddleware` | `backend/src/routes/v1/confirmPreview.js:9` chỉ `requireProjectOwner` → `req.user` undefined | Ghi bug `FIX-OPT-01`, docs tạm ghi đúng hành vi thực + cảnh báo |
| G-15 | `07` chữ ký `MediaService` TS (`signal/maskRegions`), NVENC/inpaint/abort mô tả quá đà | Thực tế: NVENC chỉ `burnSubtitlesStyled`, còn lại x264; `applySubtitleMasks` chỉ `blur/boxblur/solid/drawbox`; abort ở biên stage; lỗi `Cancelled` chung | `07_MODULE_FFMPEG.md` |
| G-16 | `08` lẫn Postgres/S3/worker-per-stage/pnpm/dist; Redis publish nhầm | CURRENT: `redis:7-alpine` internal-only (+ overlay `redis-host.yml`), `asf-api` Node22+ffmpeg, `asf-web` nginx, SQLite `/app/data/data.db` + `INSTANCE_MODE=single`, `/storage` chỉ API serve | `08_TRIEN_KHAI_VA_VAN_HANH.md` |

**Verify scope:** đọc `backend/src/routes/v1/index.js:21-37`, `backend/server.js:46-117`, `backend/src/pipeline/runner.js:224-243`, `backend/src/lib/projectStatus.js`, `docker-compose.yml`, `frontend/src/App.jsx:57-81`.

---

## 2. Phần việc Backend (docs + 1 bug OPT)

> Nguyên tắc: chỉ sửa `.md`; file `.js` bên dưới là nguồn đối chiếu, không sửa trừ `FIX-OPT-01`.

### 2.1. Routes / Auth / Upload / SSE (`src/routes/v1/*.js`, `server.js`, `middleware/*`)

- [ ] **BE-01 — Đồng bộ prefix + health/ready:** sửa mọi docs ghi sai prefix thành `/api/v1` (`server.js:48`); `GET /health` luôn 200 `{status: ok|degraded|unavailable, redis, bullmq, database.persistenceState, writes, auth.refreshFallback}` + `GET /ready` 200/503 theo `WRITE_BLOCKED` (`server.js:50-117`). Files: `06_API.md §1`, `01 §CURRENT`, `08 §healthcheck`. Verify: `curl localhost:3001/health`, `curl localhost:3001/ready`.
- [ ] **BE-02 — Đồng bộ bảng routes đầy đủ:** bổ sung routes còn thiếu trong `06` từ code: `PATCH /projects/:id/segments/:segmentId/translation`, `POST /projects/:id/translate-dub/confirm-preview (202)`, `GET/POST/DELETE /projects/:id/glossary[/:termId]`, `GET /style-presets (13)`, `GET/PUT /settings`, `GET/POST/PUT/DELETE /api-keys + GET /providers/:provider/quota`, `GET /queue|/analytics|/providers|/logs`, `GET /admin/users|providers|cleanup-tasks + POST /admin/cleanup-tasks/:id/retry + PUT /admin/users/:id`, `GET /outputs[/:id] + POST|GET /outputs/:id/youtube`, legacy alias `/upload` + resumable `/uploads`. Nguồn: `src/routes/v1/*.js`, `index.js:21-37`. Verify: đối chiếu `rg "router\.(get|post|put|patch|delete)" backend/src/routes/v1`.
- [ ] **BE-03 — Auth/SSE/mask contract:** sửa `?token=` → `?ticket=` single-use TTL 60s claim nguyên tử (`auth.js:88-147`); refresh cookie `refresh_token` HttpOnly `Path=/api/v1/auth` Lax + fallback body/header deprecated gỡ ở v2 (`client.js` + `README §8.1` làm chuẩn); CSRF Origin/Referer cho refresh/logout; masks là CRUD `/masks` không phải `mask-regions`. Files: `06`, `03 §auth`, `frontend/AGENTS.md`. Verify: `transcriptHttpContract` + `sseTicketRace` tests pass.
- [ ] **BE-04 — Upload chuẩn 8MB:** thống nhất mọi chỗ thành `CHUNK_SIZE=8MB, MAX 2GB, express.raw 16MB, PUT /uploads/:id/chunk?offset=N + POST /uploads/:id/complete → {storageKey}`; legacy `POST /upload` chỉ file nhỏ. Files: `README §3`, `00`, `06 §uploads`, `frontend/AGENTS.md`. Nguồn: `resumableUploadService.js`, `routes/v1/upload.js`. Verify: `uploadService` + `frontendUploadContract` tests.
- [ ] **BE-05 — Idempotency/cancel/cleanup/retention:** chép nguyên văn `README §8.2` vào `06` (Idempotency-Key 1-128/user TTL 7d + `409 IDEMPOTENCY_KEY_REUSE`, `DELETE` outbox `project_cleanup_tasks` sweep 60s/backoff 10 lần, `cancel` cooperative + `DELETE` khi running → 409, retention chỉ `completed/failed`, `cancelled` dọn ngay). Nguồn: `projectAdmission.js`, `projectCleanup.js`, `cancelProjectUseCase.js`. Verify: `projectIdempotency` + `cleanupDurability` tests.

### 2.2. Pipeline stages (`src/pipeline/stages/*`, `runner.js`, `recovery.js`)

- [ ] **BE-06 — Chốt tên + thứ tự stage:** sửa mọi docs thành đúng `runner.js:224-243` (SUMMARY 8, DUB 6 sequential `[ingest],[stt+merge],[translate],[ttsAlign],[render]`); xóa/đánh `[REMOVED]` mọi câu `dub.ocr`, `stt‖ocr`, `TransFlow song song`. Files: `README §2.1-2.2`, `AGENTS.md §Pipeline`, `01`, `05`. Verify: `pipelinePlan` test.
- [ ] **BE-07 — Ghi rõ STT-only + redub/in-place:** DUB giữ nhịp hình gốc, forced-align TTS speed-stretch; `PATCH .../translation` + `POST .../redub` không chạy lại STT; `confirm-preview` 202. Nguồn: `dubStt/dubMerge/dubTranslate/dubTtsAlign/dubRender.js`, `transcriptMutationService.js`. Files: `05`, `06 §redub`, `10 P3`.

### 2.3. Services / Queue / Providers (`src/services/*`, `src/queue/*`, `src/providers/*`)

- [ ] **BE-08 — Services table:** bổ sung bảng 9 services + exports chính (`projectAdmission`, `transcriptMutationService`, `resumableUploadService`, `projectCleanup`, `quotaGuardService`, `outputService`, `glossaryService`, `mediaValidation`, `legacyUploadRegistry`) + 3 usecases (`create/cancel/confirmPreview`). Files: `03`, `README §5`. Verify: `rg "^export" backend/src/services/*.js`.
- [ ] **BE-09 — Queue/worker sự thật:** sửa thành BullMQ 3 queues (`projects/notifications/cleanup` + `drain-queued` 5s), workers in-process sau `waitForRedis(3000)`, prod fail-fast, dev tiếp tục không queue; **không worker container riêng** (trích `docker-compose.yml:66-70`). Files: `01`, `08`, `AGENTS.md`. Verify: `queueLifecycle` test + `npm run check:redis`.
- [ ] **BE-10 — Provider matrix + rate-limit honesty:** bảng LLM/ASR/TTS/Vision/Translate đúng registry (`llm: gemini/openai/mock`, `asr: whisper/mock`, `tts: zerotts/edge/elevenlabs/openai/google/mock`, `vision: gemini/mock`, `translate: google_translate`); ghi rõ NOT IMPLEMENTED: round-robin/cooldown, `safetyMargin`/`CACHE_TTL` bị bỏ qua, `quotaGuard` chỉ `GET /quota`, limiter in-memory mất state khi restart. Files: `11`, `04 §ApiKeys`, `10 P4`, `README §4 matrix`. Verify: `geminiRetry` + `providerFailover` tests.

### 2.4. Database (`src/db/schema.js`, `seed.js`) + Media (`src/media/*`)

- [ ] **BE-11 — Schema 25 tables + enum lowercase:** liệt kê đủ 25 tables (`users…upload_sessions`), nhấn `projects.mode SUMMARY|TRANSLATE_DUB`, `status` lowercase + legacy `success→completed`, `transcript_version/run_token/lease/video_hash`, `generation_jobs UNIQUE(project_id,type)`, `transcript_segments` có `tts_clip_key/tts_duration_ms`, `ocr_regions DRAFT|APPROVED|DISABLED`, `sse_tickets/idempotency/cleanup_tasks`; tách Prisma TARGET ra riêng; xóa `MediaConsent/MediaJob`. Files: `02`, `01 ERD`. Verify: `rg "CREATE TABLE" backend/src/db/schema.js`.
- [ ] **BE-12 — FFmpeg reality:** `resolveBin FFMPEG_PATH→PATH→C:\ffmpeg\bin`, `enqueue` chống crash -22, `SIGTERM→SIGKILL` 5s; NVENC chỉ burn subtitles, timeout stage 15/30m + BURN 20m; masks chỉ blur/boxblur/solid/drawbox (inpaint cần provider ngoài); abort biên stage. Files: `07`, `README §4`. Nguồn: `media/ffmpeg.js`, `mediaService.js`. Verify: ghi `ffmpeg -version` thực tế hoặc SKIP có lý do.
- [ ] **BE-13 — FIX-OPT-01 (code bug, tách riêng, không bắt buộc cho docs-xong):** thêm `authMiddleware` vào `POST /:id/translate-dub/confirm-preview` (`confirmPreview.js:9` hiện chỉ `requireProjectOwner` → `req.user` undefined). Sửa 1 dòng + thêm test 401 khi thiếu Bearer. Ghi vào plan nhưng thực hiện chỉ khi owner duyệt. Verify: `npm test -- confirmPreview` (tên file thực tế khi chạy).

---

## 3. Phần việc Frontend (docs + contract)

> Nguồn truth: `frontend/src/App.jsx`, `src/api/*.js`, `src/pages/*`, `src/components/timeline/*`, `vite.config.js`.

### 3.1. Routes / Pages (`src/App.jsx:57-81`, `src/pages/*`)

- [ ] **FE-01 — Route table 18 pages:** đồng bộ `04` + `frontend/AGENTS.md` thành: public `/ /login /register /forgot-password /reset-password /timeline(TimelineDemo)`; protected `/dashboard /projects /projects/new(CreateProject wizard 2 mode) /projects/:id(ProjectDetail 2-panel DUB + VideoTimeline) /queue /outputs /analytics /settings /settings/providers(+alias /providers) /settings/api-keys(+alias /api-keys) /logs /admin + * → PageNotFound`. Ghi guard `ProtectedRoute → /login`, `ThemeProvider>AuthProvider>QueryClientProvider>Router>Toaster`. Verify: mở từng route dev `npm run dev` + `rg "Route path" src/App.jsx`.
- [ ] **FE-02 — CreateProject wizard contract:** `POST /api/v1/projects {mode: SUMMARY|TRANSLATE_DUB, title, ...}` (SUMMARY: `title/language/style/targetDurationSec/sourceVideoKey?`; DUB: `sourceLanguage?/targetLanguage/stylePreset/enableDubbing/voiceId?/subPosition?/sourceVideoKey`); `GET /style-presets → 13 slug fallback`; backend tự chạy pipeline sequential sau tạo. Files: `04 §wizard`, `frontend/AGENTS.md`, `06`. Nguồn: `pages/CreateProject.jsx`, `api/projects.js`. Verify: tạo thử 1 project mỗi mode trên dev.
- [ ] **FE-03 — ProjectDetail realtime:** SSE `POST .../sse-ticket` → `EventSource .../events?ticket=` (single-use 60s, events `progress/done/error`, normalize `__project__:success→completed`, backoff 1s/2s/5s) + fallback poll `GET /projects/:id` khi `sseAvailable===false`; DUB `transcript[]` (OCR đã gỡ, không ghi `ocrRegions[]` nữa); SUMMARY `timeline[]/scenes[]`. Files: `04`, `frontend/AGENTS.md`. Nguồn: `pages/ProjectDetail.jsx`, `hooks/useJobEvents.js`. Verify: `sseFallbackContract` backend test + click SSE trên dev.

### 3.2. Components / Timeline / Style (`src/components/*`, `src/lib/constants.jsx`)

- [ ] **FE-04 — Component inventory:** nhóm Shell (`Layout/PageHeader/StatCard/EmptyState/Loading/ProtectedRoute/ErrorBoundary/ThemeToggle`), Auth/Landing visuals (`AuthLayout/Auth3DBackground/FluidAurora/.../Hero*`), Project (`project/ProjectHeader/PipelineStatus/WorkflowPipeline/MaskEditor Canvas MANUAL`), Timeline CapCut (`timeline/VideoTimeline/TimelineClip/TimeRuler/TrackSidebar/Playhead/FloatingToolbar/timelineStore/timelineUtils`); `ui/*` ~50 shadcn gộp 1 dòng. Files: `04 §components`, `README §5`. Verify: `glob src/components/**/*` + mở `/timeline` demo.
- [ ] **FE-05 — Constants/status mapping:** `STATUS_LABELS` + `normalizeProjectStatusForDisplay(success→completed)`, `STAGE_LABELS` 8 summary + 6 dub, `MODE_LABELS`, 13 `STYLE_PRESETS_FALLBACK` slug, `SOURCE_LANGUAGES auto/en/ja/ko/zh`, `TARGET vi/en`. Files: `04 §constants`, `frontend/AGENTS.md`. Nguồn: `lib/constants.jsx`. Verify: `rg "STYLE_PRESETS_FALLBACK" src/lib/constants.jsx`.
- [ ] **FE-06 — Style/token giữ nguyên:** dark `#0F1117`, thẻ bo góc, accent xanh, framer-motion transition; không thêm SDK/BaaS, chỉ gọi qua `api/client.js` (baseURL `VITE_API_BASE||/api/v1`, `withCredentials`, Bearer memory-only `tokenStore.js`, single-flight 401 → `POST /auth/refresh` retry 1 lần). Files: `04 §style`, `frontend/AGENTS.md`. Verify: `npm run lint` sạch trước khi đóng.

### 3.3. API integration checklist (FE gọi BE)

- [ ] **FE-07 — Contract table:** `authApi (register/login/refresh/logout/me/forgot/reset)`, `projectsApi (list/get/create/timeline/regenerate/remove/summaryStart/translateDubStart/jobs/retryJob/cancel/transcript/updateTranscript/updateSegmentTranslation/redub/masks×4/glossary×3/confirmPreview/sseTicket/stylePresets)`, `uploadApi (resumable init/chunk?offset/complete vs multipart fallback)`, `outputsApi (list/get/youtube/youtubeStatus)`, `extra (queue/logs/analytics/providers/settings/apiKeys/admin)`. Ghi rõ `confirmPreview` hiện orphan (BE xong, `ProjectDetail` chưa gọi) + `stylePresets catch→null fallback`. Files: `04 §API`, `06`, `frontend/AGENTS.md`. Nguồn: `src/api/*.js`. Verify: `rg "apiClient\.(get|post|put|patch|delete)" src/api` khớp `BE-02`.

---

## 4. Phần việc QA / Tester (gates + kịch bản)

### 4.1. Gates bắt buộc (chạy sau mọi sửa docs liên quan code)

- [ ] **QA-00 — Baseline:** `git status`, `git diff --stat`, `node -v`, `npm -v`, `npm run check:redis` (backend), `curl /health`, `curl /ready`, `ffmpeg -version`; ghi PASS/SKIP/BLOCKED + version thực.
- [ ] **QA-01 — Backend regression:** `cd backend; npm test` (hiện 128 file `*.test.mjs` qua `scripts/run-tests.mjs`) — PASS toàn bộ mới được đóng plan; nếu Redis/FFmpeg thiếu, ghi SKIP từng file kèm lý do, không ghi PASS khống.
- [ ] **QA-02 — Backend lint:** `cd backend; npm run lint` (`eslint src tests scripts --quiet`) — 0 error.
- [ ] **QA-03 — Frontend lint/build/typecheck:** `cd frontend; npm run lint`, `npm run build` (`vite build`), `npm run typecheck` (`tsc -p jsconfig.json`) — cả 3 PASS; không chạy/viết `npm test` cho frontend.
- [ ] **QA-04 — Contract check:** `frontend/src/api/*` vs `backend/src/routes/*` (BE-02 ↔ FE-07) khớp method/path; `vite.config.js` proxy `/api + /storage → localhost:3001` còn hiệu lực.

### 4.2. Kịch bản test theo nhóm (chọn lọc, không chạy full pipeline video nếu thiếu FFmpeg)

- [ ] **QA-BE-AUTH:** `passwordReset`, `passwordResetRace`, `refreshRotationRace`, `csrfRefresh`, `corsAllowlist`, `configProduction`, `seedProductionGuard`.
- [ ] **QA-BE-PROJECT:** `projectAdmission`, `projectIdempotency`, `concurrencyLimit`, `cancelStageGuard`, `heartbeatRecovery`, `queueLifecycle`, `deploymentSmoke`.
- [ ] **QA-BE-TRANSCRIPT/MASK:** `transcriptMutationService`, `transcriptRevision`, `transcriptAtomic`, `transcriptHttpContract`, `redubUsesManual`, `maskLifecycle`, `maskApprovedImmutable`, `maskRender`, `sanitizeOverlaps`, `dedupeDuplicates`.
- [ ] **QA-BE-PIPELINE:** `pipelinePlan`, `pipelineRetry`, `dubTranslate.batch`, `dubMerge`, `translateValidate`, `translateQa`, `ttsCacheResume`, `renderBlock`, `sttOverlapStitch` (mock mode, không cần FFmpeg thật).
- [ ] **QA-BE-UPLOAD/SSE/DB:** `uploadService`, `uploadComplete`, `uploadHttpContract`, `frontendUploadContract`, `sseTicketRace`, `sseFallbackContract`, `sseRouteIntegration`, `persistenceAtomicity`, `persistenceHealth`, `readinessState`, `safeMediaStatic`, `filesystemSecurity`, `cleanupDurability`.
- [ ] **QA-FE-MANUAL:** mở `/`, `/login`, `/dashboard`, `/projects/new` (tạo SUMMARY + TRANSLATE_DUB thử), `/projects/:id` (SSE progress + transcript + mask canvas), `/timeline` demo, `/settings/providers`, `/admin`; F12 không lỗi CORS/401 loop; `localStorage` không chứa refresh token.

### 4.3. Đóng gói

- [ ] **QA-REPORT — Ghi `docs/superpowers/verify-docs-sync-<date>.md`:** bảng file md đã sửa (đường dẫn + dòng), lệnh đã chạy + kết quả PASS/SKIP, version Redis/FFmpeg/Node thực tế, 3 contract diff còn lại (nếu có) + owner.
- [ ] **QA-SIGNOFF — Khẳng định:** "`README §5/§8`, `AGENTS.md`, `Video_AI_docs/docs/00–11`, `frontend/AGENTS.md` đã khớp code; `10_TASKS.md` là truth trạng thái; FIX-OPT-01 chờ duyệt riêng."

---

## Phụ lục A — Thứ tự thực hiện đề xuất (cho team 3 người)

1. **BE-owner:** SCOPE-03 → BE-01→BE-05 → BE-06→BE-07 → BE-08→BE-10 → BE-11→BE-12.
2. **FE-owner (song song):** FE-01→FE-03 → FE-04→FE-06 → FE-07 (đối chiếu BE-02).
3. **QA-owner (cuối mỗi batch):** QA-00→QA-04 → QA-BE-* → QA-FE-MANUAL → QA-REPORT + SIGNOFF.
4. Mỗi file md xong phải `git diff` review trước khi sang file tiếp theo; không gộp nhiều file vào 1 commit nếu chưa được yêu cầu commit.

## Phụ lục B — File chạm (whitelist, chỉ .md trừ FIX-OPT)

`README.md`, `AGENTS.md`, `frontend/AGENTS.md`, `Video_AI_docs/docs/00_TAM_NHIN_VA_YEU_CAU.md`, `01_KIEN_TRUC_TONG_THE.md`, `02_THIET_KE_CO_SO_DU_LIEU.md`, `03_THIET_KE_BACKEND.md`, `04_THIET_KE_FRONTEND.md`, `05_THIET_KE_PIPELINE_CHI_TIET.md`, `06_API.md`, `07_MODULE_FFMPEG.md`, `08_TRIEN_KHAI_VA_VAN_HANH.md`, `09_DONG_GOP.md`, `10_TASKS.md` (chỉ bổ sung trạng thái, không đổi DONE thành TODO), `11_RATE_LIMIT_VA_FREE_TIER.md`. Cấm chạm: `backend/*.js`, `frontend/src/*`, `.env`, `data.db`, `storage/*`, `*.log` (trừ FIX-OPT-01 đã duyệt).
