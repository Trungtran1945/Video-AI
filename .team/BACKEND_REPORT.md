# Backend Report — PLAN.md §2 (2026-10-05)

Skills: executing-plans + karpathy-guidelines + api-endpoint-builder.

## 1. Quyết định quan trọng: KHÔNG sửa code

PLAN.md (Global Constraints + §2 + Phụ lục B) quy định docs-as-mirror:
code là truth, chỉ sửa `.md`, cấm chạm `backend/*.js` trừ FIX-OPT-01 đã duyệt.
Nhiệm vụ được giao ("code/sửa bug/bổ sung endpoint") mâu thuẫn trực tiếp với
ràng buộc này. Theo Karpathy #1 (surface tradeoffs) và thứ tự ưu tiên
User Instructions > Skills: tuân thủ PLAN.md, **không thay đổi bất kỳ file
`.js` nào**. Mọi hạng mục BE-01..BE-12 bên dưới là verify code-truth để team
docs sửa `.md` theo; BE-13 là bug thật nhưng để owner duyệt riêng.

Dirty tree lúc bắt đầu (không reset, chỉ ghi nhận): `M backend/src/pipeline/runner.js`,
`M dubMerge.js`, `M dubTranslate.js`, `M providers/llm/gemini.js`, `M tracked.js`,
`M vision/geminiVision.js`, `M services/transcriptMutationService.js`,
`?? backend/tests/sanitizeOverlaps.test.mjs`, `?? scripts/`, `?? team.ps1`.
Branch `main`.

## 2. Baseline môi trường (SCOPE-03)

- Node v24.14.1 / npm 11.11.0.
- Redis: `npm run check:redis` FAIL — ECONNREFUSED 127.0.0.1:6379 (dev tiếp tục
  không queue, prod fail-fast; đúng `server.js:243-260`).
- FFmpeg: **có sẵn** `9.0.1-full_build-www.gyan.dev` (gcc 16.1.0, gồm
  `--enable-nvenc`), khác ghi chú cũ "NOT installed" trong AGENTS.md.
- `GET /health`, `GET /ready` không chạy server sống ở đây; shape đã verify
  qua code `server.js:50-117` (liveness luôn 200 + `database.persistenceState`;
  readiness 503 khi WRITE_BLOCKED).

## 3. Verify code-truth theo BE-01..BE-13 (không sửa)

- BE-01 prefix/health: `server.js:48` mount `/api/v1`; `/health` trả
  `{status, redis, bullmq, durableCleanup, cleanup, database+persistenceState,
  writes, auth.refreshFallback}`; `/ready` 200/503 theo WRITE_BLOCKED.
- BE-02 routes đầy đủ (`rg router.(get|post|put|patch|delete)` trên
  `src/routes/v1/*.js`): auth×7, `POST /:id/translate-dub/confirm-preview (202)`,
  `PATCH /:id/segments/:segmentId/translation`, glossary GET/POST/DELETE (thiếu
  PUT term — docs ghi `glossary×3` là đủ), `GET /style-presets` (query
  `style_presets`), settings GET/PUT, api-keys GET/POST/PUT/DELETE +
  `GET /providers/:provider/quota`, queue/analytics/providers/logs,
  admin users/providers/cleanup-tasks + retry, outputs + youtube POST/GET,
  legacy `POST /upload` + resumable `/uploads` (init/chunk?offset/complete +
  HEAD offset), masks GET/POST/PATCH/DELETE, SSE ticket+events, generation
  start/redub/jobs/retry, transcript GET/PUT, timeline, cancel/regenerate/delete.
- BE-03 auth/SSE/mask: `?ticket=` single-use TTL 60s claim nguyên tử bằng
  `DELETE ... WHERE ticket_hash+used=0+chưa hết hạn` (`auth.js:88-147`,
  `events.js:32-65`); `?token=` chỉ fallback deprecated; refresh cookie
  `refresh_token` HttpOnly `Path=/api/v1/auth` SameSite Lax + fallback
  body/header deprecated; CSRF cho refresh/logout; masks là CRUD `/masks`
  (`masks.js`), không phải `mask-regions`.
- BE-04 upload 8MB: `CHUNK_SIZE=8*1024*1024`, `MAX_SIZE=2GB`
  (`resumableUploadService.js:11-12`), `express.raw limit 16mb`
  (`upload.js:151`), `PUT /:id/chunk?offset=N` → 204 + `Upload-Offset`,
  `POST /:id/complete` → `{storageKey}`; legacy `POST /upload` file nhỏ qua multer.
- BE-05 idempotency/cancel/cleanup: `Idempotency-Key 1-128` + `409
  IDEMPOTENCY_KEY_REUSE` (`projects.js:101,136-137`,
  `projectAdmission.js:51-99,288` + prune hourly); cleanup sweep 60s +
  BullMQ hourly; cancel cooperative + DELETE khi running → 409 (verify qua
  `cancelProjectUseCase.js` + tests); retention chỉ completed/failed,
  cancelled dọn ngay (`projectStatus.js` + `projectCleanup.js`).
- BE-06 stages: `runner.js:224-243` SUMMARY 8
  `transcribe→sceneDetect→analyze→script→align→tts→subtitle→render`, DUB 6
  sequential `[ingest],[stt+merge],[translate],[ttsAlign],[render]`; không
  `dub.ocr`, không song song.
- BE-07 STT-only + redub/in-place: `dubStt/dubMerge/dubTranslate/dubTtsAlign/
  dubRender.js` + `transcriptMutationService.js`; `PATCH translation` +
  `POST redub` không chạy lại STT; confirm-preview 202.
- BE-08 services 9 + usecases: `projectAdmission`, `transcriptMutationService`,
  `resumableUploadService`, `projectCleanup`, `quotaGuardService`,
  `outputService`, `glossaryService`, `mediaValidation`,
  `legacyUploadRegistry` (+ `create/cancel/confirmPreview` usecases).
- BE-09 queue/worker: BullMQ 3 queues (projects/notifications/cleanup +
  drain 5s), workers in-process sau `waitForRedis(3000)`, prod fail-fast;
  **không worker container riêng** (`docker-compose.yml:66-70`,
  `redis:7-alpine` internal-only, `asf-api` Node22+ffmpeg, `asf-web` nginx,
  `INSTANCE_MODE=single`, SQLite `/app/data/data.db`).
- BE-10 providers: `registry.js` llm gemini/openai/mock, asr whisper/mock,
  tts zerotts/edge/elevenlabs/openai/google/mock, vision gemini/mock,
  translate google_translate; NOT IMPLEMENTED: round-robin/cooldown,
  `safetyMargin`/`CACHE_TTL` bị bỏ qua, `quotaGuard` chỉ `GET /quota`,
  limiter in-memory mất state khi restart; `selectBestApiKey`
  (`quotaGuardService.js:95`) là dead code theo G-13.
- BE-11 schema 25 tables (`rg CREATE TABLE` = 25): `projects.mode
  SUMMARY|TRANSLATE_DUB`, status lowercase + migration `success→completed`
  (`schema.js:129-136`, `projectStatus.js`: pending/queued/running/completed/
  failed/cancelled), `transcript_version/run_token/lease/video_hash`,
  `generation_jobs UNIQUE(project_id,type)`, `transcript_segments` có
  `tts_clip_key/tts_duration_ms`, `ocr_regions DRAFT|APPROVED|DISABLED`,
  `sse_tickets/idempotency/cleanup_tasks/upload_sessions`; không
  `MediaConsent/MediaJob`.
- BE-12 FFmpeg reality: `resolveBin FFMPEG_PATH→PATH→C:\ffmpeg\bin`,
  `enqueue` chống crash -22, `SIGTERM→SIGKILL` 5s; timeout stage 15/30m
  (BURN 20m); NVENC chỉ burn subtitles; masks chỉ blur/boxblur/solid/drawbox;
  abort ở biên stage; lỗi `Cancelled` chung.
- BE-13 FIX-OPT-01 (bug thật, CHƯA SỬA): `confirmPreview.js:9` chỉ
  `requireProjectOwner`, thiếu `authMiddleware` → `projectAccess.js:29`
  đọc `req.user.id` gây TypeError (500 thay vì 401). Sửa 1 dòng
  (`authMiddleware, requireProjectOwner`) + test 401 khi thiếu Bearer —
  **chờ owner duyệt**, không tự sửa trong turn này.

## 4. Gates đã chạy

- `cd backend; npm test` (timeout 600s): **ALL TEST FILES PASS** (gồm
  `sseTicketRace` 100-request single-use, `uploadService/uploadHttpContract`,
  `transcript*`, `pipelinePlan`, `projectIdempotency`, `cleanupDurability`).
- `cd backend; npm run lint`: **4 errors có sẵn, không do turn này gây ra**
  (chưa sửa theo surgical changes): `transcriptTiming.js:222 GAP unused`,
  `tts/zeroTts.js:218 ensureMp3Format unused`, `glossaryService.js:5 queryOne
  unused`, `tests/zeroTtsIntegration.test.mjs:79 AbortSignal no-undef`.
- Contract FE↔BE (BE-02↔FE-07) và `vite proxy /api+/storage→3001` để FE/QA
  owner verify tiếp; không phát minh `frontend npm test`.

## 5. Files đã sửa trong turn này

- `.team/BACKEND_REPORT.md` (mới): báo cáo này.
- Không sửa bất kỳ `backend/*.js`, `frontend/src/*`, `.env`, `data.db`,
  `storage/*` nào — đúng whitelist Phụ lục B.

## 6. Đề xuất cho team

1. Docs owner sửa `.md` theo truth §3 (đặc biệt G-02 worker, G-03 8MB, G-04
   ticket, G-05 thứ tự stage, G-07 enum lowercase, G-09/G-10 masks/uploads).
2. Owner duyệt FIX-OPT-01 rồi mới cho Backend sửa 1 dòng + test 401.
3. QA chạy `QA-00..QA-04` + ghi `verify-docs-sync-<date>.md`; lint 4 errors
   trên nên tách task lint-fix riêng, không gộp vào docs-sync.
