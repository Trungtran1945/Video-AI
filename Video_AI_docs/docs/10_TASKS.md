# Roadmap (Lộ trình triển khai)

Dựa trên thiết kế tại [`01_KIEN_TRUC_TONG_THE.md`](01_KIEN_TRUC_TONG_THE.md) và
[`05_THIET_KE_PIPELINE_CHI_TIET.md`](05_THIET_KE_PIPELINE_CHI_TIET.md).

## Giai đoạn 1 — Nền tảng
- [ ] Monorepo pnpm, tsconfig strict, lint/prettier/husky.
- [ ] Prisma schema (`02_THIET_KE_CO_SO_DU_LIEU.md`) + migrate SQLite.
- [ ] Auth JWT access/refresh, RBAC, mã hoá API key.
- [ ] Storage abstraction (local), Provider Pattern skeleton + DI.
- [ ] Checkbox xác nhận bản quyền bắt buộc khi tạo project (`copyrightAcknowledged`).
- [ ] Giới hạn concurrency `MAX_CONCURRENT_PROJECTS_PER_USER` + trạng thái `QUEUED`.
- [ ] **RateLimiter (Token Bucket + Sliding Window)** + `ProviderCache` bọc mọi provider client,
      seed `ProviderRateLimit` mặc định cho free tier (`11_RATE_LIMIT_VA_FREE_TIER.md`).
- [ ] Provider `mock`/local (LLM, TTS, Vision) cho dev/CI — không tốn quota thật (`11` §6).

## Giai đoạn 2 — Pipeline SUMMARY (review phim)
- [ ] ingest + transcribe (ASR).
- [ ] scene-detect + Vision mô tả cảnh.
- [ ] LLM sinh kịch bản review (ScriptSegment).
- [ ] **AlignService** (đồng bộ giọng ↔ cảnh).
- [ ] TTS + subtitle + render (ffmpeg).

## Giai đoạn 3 — Pipeline TRANSLATE_DUB (dịch & lồng tiếng)
- [ ] Upload resumable (chunk 5–10MB, kiểu TUS) + ingest: demux, normalize LUFS.
- [ ] `dub.stt` — ASR + word timestamps + speaker diarization.
- [ ] `dub.ocr` — frame sampling 1–2 fps → OCR → merge OcrRegion (IoU theo thời gian).
- [ ] BullMQ Flow Producer: `dub.merge` chờ `dub.stt` ‖ `dub.ocr` song song (xem `01` §5.1).
- [ ] `dub.translate` — LLM context window + 13 StylePreset routing.
- [ ] Bước "Xem trước & Xác nhận" (`POST /projects/:id/translate-dub/confirm-preview`) trước khi
      render cuối (FR-J2).
- [ ] `dub.ttsAlign` — TTS (tuỳ chọn) + ForcedAlignService (tempo/pause/rút gọn).
- [ ] Overlap Detection cho chỉnh thời gian thủ công segment (quy tắc thống nhất, xem `03` §3).
- [ ] `dub.render` — mask hardsub (blur/fill/inpaint) → burn-in ASS → audio mix → mux NVENC
      (hỗ trợ huỷ giữa chừng qua `AbortSignal`, xem `07` §3.1).
- [ ] SSE progress realtime (`/projects/:id/events`) + SubRegionEditor Canvas.
- [ ] `POST /projects/:id/cancel` — huỷ pipeline đang chạy (FR-J1).

## Giai đoạn 4 — Vận hành
- [ ] BullMQ worker scale, retry.
- [ ] Dashboard (wizard, timeline preview, queue, logs).
- [ ] YouTube upload (kèm cảnh báo bản quyền trước publish), Analytics, Admin.
- [ ] Notification service (email/push khi pipeline hoàn thành/thất bại — FR-J3).
- [ ] Cron `cleanup.sweep` dọn file trung gian/nguồn theo `Project.expiresAt` (NFR-13).
- [ ] `QuotaGuardService` + banner cảnh báo `quota_risk` trên UI; đa API key round-robin/cooldown
      tự động khi dùng free tier (`11` §4, §5).
- [ ] Docker / CI / production (Postgres, S3).
