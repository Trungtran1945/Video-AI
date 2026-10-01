# Roadmap (Lộ trình triển khai)

Dựa trên thiết kế tại [`01_KIEN_TRUC_TONG_THE.md`](01_KIEN_TRUC_TONG_THE.md) và
[`05_THIET_KE_PIPELINE_CHI_TIET.md`](05_THIET_KE_PIPELINE_CHI_TIET.md).

> Quy ước nhãn (đối chiếu code `backend/` + `frontend/`): [DONE] đã cài đặt;
> [PARTIAL] cài đặt một phần; [NOT IMPLEMENTED] thiết kế chưa cài đặt;
> [PLANNED] mục tiêu tương lai giữ lại (chưa code).

## Giai đoạn 1 — Nền tảng
- [NOT IMPLEMENTED] Monorepo pnpm, tsconfig strict, lint/prettier/husky. (CURRENT: JS thuần, npm riêng từng app, không `pnpm-workspace`; lint/typecheck chỉ FE — xem `09` §2.)
- [NOT IMPLEMENTED] Prisma schema (`02_THIET_KE_CO_SO_DU_LIEU.md`) + migrate SQLite. (CURRENT: schema SQL thuần `backend/src/db/schema.js`, không `prisma/`.)
- [DONE] Auth JWT access/refresh, RBAC, mã hoá API key. (`routes/v1/auth.js`; OWNER/ADMIN; `MASTER_KEY` AES — xem `06` §1, `08` §3.)
- [DONE] Storage abstraction (local), Provider Pattern skeleton + DI. (`providers/registry.js` + `callProvider` bọc mọi provider; lưu local `projectDir`/`toStorageKey` — xem `08` §1.)
- [DONE] Checkbox xác nhận bản quyền bắt buộc khi tạo project (`copyrightAcknowledged`). (`createProjectUseCase.js:13`, `projects.js:43`; thiếu → `COPYRIGHT_001`.)
- [DONE] Giới hạn concurrency `MAX_CONCURRENT_PROJECTS_PER_USER` + trạng thái `QUEUED`. (`config.js:31` mặc định 2; vượt ngưỡng → `queued` — xem `03` §3, `06` §8 `LIMIT_001`.)
- [DONE] **RateLimiter (Token Bucket + Sliding Window)** + `ProviderCache` bọc mọi provider client,
      seed `ProviderRateLimit` mặc định cho free tier (`11_RATE_LIMIT_VA_FREE_TIER.md`). (`lib/rateLimiter.js`, `lib/callProvider.js`, bảng `provider_cache`/`provider_rate_limits`.)
- [DONE] Provider `mock`/local (LLM, TTS, Vision) cho dev/CI — không tốn quota thật (`11` §6). (`mockAsr`/`mockTts`/`mockLlm`; `DEFAULT_PROVIDER_MODE=mock`.)

## Giai đoạn 2 — Pipeline SUMMARY (review phim)
- [DONE] ingest + transcribe (ASR). (`summaryTranscribe.js` → `transcript.json`.)
- [DONE] scene-detect + Vision mô tả cảnh. (`summarySceneDetect.js`, `summaryAnalyze.js` qua `callProvider` vision.)
- [DONE] LLM sinh kịch bản review (ScriptSegment). (`summaryScript.js`.)
- [DONE] **AlignService** (đồng bộ giọng ↔ cảnh). (`summaryAlign.js`; invariant ở `09` §5.)
- [DONE] TTS + subtitle + render (ffmpeg). (`summaryTts.js`, `summarySubtitle.js`, `summaryRender.js`.)

## Giai đoạn 3 — Pipeline TRANSLATE_DUB (dịch & lồng tiếng)
- [DONE] Upload resumable (chunk 5–10MB, kiểu TUS) + ingest: demux, normalize LUFS. (Chunk 8MB cố định, limit 2GB — `upload.js:43,62`, `06` §2.1; `dubIngest.js` loudnorm −16 LUFS — `07` §2.12.)
- [DONE] `dub.stt` — ASR + 15s overlap stitching (`buildSttChunks`, `dedupeOverlapSegments`), lọc ảo giác Whisper (`filterHallucinatedSegments`), canonical ASR cache (`buildAsrCacheInput`), diarization `speaker=NULL` ở v1.
- [REMOVED] `dub.ocr` — Đã gỡ bỏ hoàn toàn khỏi codebase; TRANSLATE_DUB chuyển sang STT-only (`dub.ingest → dub.stt → dub.merge → dub.translate → dub.ttsAlign → dub.render`). Phụ đề neo đáy `\an2`. Dữ liệu OCR cũ cô lập về `source = 'LEGACY_OCR'`.
- [NOT IMPLEMENTED] BullMQ Flow Producer: `dub.merge` chờ `dub.stt` ‖ `dub.ocr` song song (xem `01` §5.1). (CURRENT chạy sequential `startDubSequential` — `runner.js:70-108`; không FlowProducer.)
- [DONE] `dub.translate` — LLM context window + 13 StylePreset routing; chiến lược dịch 3 vòng (TransFlow: parallel batch → chunk 5 → single fallback); multi-shape payload parser; gate chặn CJK leakage; tự động sửa ngữ nghĩa (`repairTranslationWithLlm`); `TRANSLATION_VERSION = 4`.
- [PARTIAL] Bước "Xem trước & Xác nhận" (`POST /projects/:id/translate-dub/confirm-preview`) trước khi
      render cuối (FR-J2). (BE CURRENT — `confirmPreview.js` + useCase; FE orphan — wrapper `api/projects.js:21` có nhưng `ProjectDetail` không gọi; xem `04` §4.)
- [DONE] `dub.ttsAlign` — TTS (tuỳ chọn) + ForcedAlignService: `TEMPO_MAX = 1.35` (giữ pitch tự nhiên), pause-expansion mở rộng vào khoảng lặng câu kế, cắt khoảng lặng thừa (`trimAudioSilence`), fade-out đuôi audio clip cắt ngắn.
- [DONE] Overlap Detection cho chỉnh thời gian thủ công segment (quy tắc thống nhất, xem `03` §3). (`dubData.js:83` `GAP=0.1`; đè N-1/N+1 → 400 `VAL_002`.)
- [DONE] `dub.render` — Burn-in phụ đề ASS + burn mask `APPROVED` (`loadSubtitleRegions` + `applySubtitleMasks` với blur/solid) + dynamic sidechain ducking (−12dB khi có tiếng nói, thở về 100% khi im lặng) + mux NVENC/libx264.
- [DONE] SSE progress realtime (`/projects/:id/events?ticket=...`) + `MaskEditor.jsx` Canvas (letterbox-aware, live preview blur/solid, quản lý lifecycle DRAFT/APPROVED/DISABLED, khoá sửa mask APPROVED).
- [DONE] `POST /projects/:id/cancel` — huỷ pipeline đang chạy (FR-J1). (`cancelProjectUseCase`: job/project → `cancelled`, abort + dọn tmp, idempotent — xem `05` §E.4.)
- [DONE] `POST /projects/:id/regenerate` — chạy lại pipeline tự động hoặc chọn lọc theo giai đoạn (`fromStage`), giao diện dropdown menu tại `ProjectHeader.jsx`.

## Giai đoạn 4 — Vận hành
- [DONE] BullMQ worker scale, retry. (Retry thủ công `jobs/:type/retry` + chờ quota `RETRY_WAITING`; worker `notifications`/`cleanup`; scale ngang qua profile `scale` — xem `08` §5.)
- [DONE] Dashboard (wizard, timeline preview, queue, logs). (FE: `Dashboard`, `CreateProject`, `ProjectDetail`, `Queue`, `Logs`.)
- [DONE] YouTube upload (kèm cảnh báo bản quyền trước publish), Analytics, Admin. (YouTube là stub — `outputs.js:39-61` ghi `youtube_uploads` `pending`, upload thật chưa gắn; `Analytics.jsx`, `Admin.jsx` có.)
- [DONE] Notification service (email/push khi pipeline hoàn thành/thất bại — FR-J3). (`notifyQueue` + `notifyWorker` nodemailer SMTP; runner enqueue khi done/fail, cancel cũng enqueue; thiếu SMTP thì skip graceful — `notifyWorker.js:17-20`.)
- [DONE] Cron `cleanup.sweep` dọn file trung gian/nguồn theo `Project.expiresAt` (NFR-13). (`cleanupQueue` + `cleanupWorker` repeatable — xem `08` §6.1.)
- [PARTIAL] `QuotaGuardService` + banner cảnh báo `quota_risk` trên UI; đa API key round-robin/cooldown
      tự động khi dùng free tier (`11` §4, §5). (Guard [DONE một phần] — snapshot/warning + `GET /quota` + `QuotaBar` ở `ApiKeys`; banner toàn cục [PLANNED]; `selectBestApiKey` chết — registry chỉ lấy theo `priority`, không xoay vòng [PLANNED].)
- [PARTIAL] Docker / CI / production (Postgres, S3). (Docker + CI [DONE] — `08` §1/§2/§4; Postgres/S3 [PLANNED] — CURRENT SQLite file + local.)
