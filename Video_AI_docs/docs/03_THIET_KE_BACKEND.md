# 03 — Thiết kế Backend

> **Lưu ý Triển khai:** Thiết kế target hướng tới TypeScript strict + `apps/api/`.
> Triển khai hiện tại dùng JavaScript (ES modules) trong `backend/` với `sql.js` (SQLite in-memory + file persistence) thay vì Prisma.

Backend là ứng dụng Node.js (>=18 ESM) Express, tổ chức theo nguyên tắc **Clean Architecture** và **Provider Pattern**.

---

## 1. Cấu trúc thư mục thực tế (`backend/src/`)

```
backend/
├── scripts/                  # check-redis.mjs, run-tests.mjs, dev.mjs, zerotts_service.py
├── src/
│   ├── config.js             # Quản lý biến môi trường tập trung, CORS origin allowlist
│   ├── db.js                 # sql.js wrapper, atomic snapshot, single-writer lock, persistence health
│   ├── db/
│   │   ├── schema.js         # Khởi tạo 30 bảng SQLite (DDL)
│   │   ├── seed.js           # Dữ liệu khởi tạo (Admin, Settings, 13 StylePresets, RateLimits)
│   │   └── query.js          # Hàng đợi tuần tự hoá truy vấn ghi, query/queryOne/run
│   ├── lib/                  # httpError, safePath, callProvider, providerFailover, rateLimiter
│   ├── media/                # ffmpeg.js (serialize Windows process), mediaService.js
│   ├── middleware/           # auth, projectAccess, safeMediaStatic, sseAuth
│   ├── pipeline/             # runner.js (4 mode), context.js, forcedAlignService.js, eventBus.js
│   │   └── stages/           # dub* (7 stages), summary* (8 stages), script* (7 stages), composer* (3 stages)
│   ├── providers/            # registry.js, tracked.js, rateLimit.js
│   │   ├── asr/              # openaiWhisper.js, mockAsr.js
│   │   ├── image/            # slideImage.js
│   │   ├── llm/              # gemini.js, openai.js, mockLlm.js
│   │   ├── translate/        # googleTranslate.js
│   │   ├── tts/              # edgeTts.js, elevenlabs.js, googleTts.js, openaiTts.js, zeroTts.js, mockTts.js
│   │   └── vision/           # geminiVision.js, mockVision.js
│   ├── queue/                # BullMQ queues & workers (projectQueue, notifyQueue, cleanupQueue, drainQueue)
│   ├── routes/v1/            # Các route API REST v1 (projects, uploads, outputs, composerAssets...)
│   ├── services/             # resumableUpload, scriptService, composerService, projectAdmission, quotaGuard...
│   └── usecases/             # confirmPreviewUseCase, cancelProjectUseCase
├── server.js                 # Điểm khởi chạy Express server, health check, recovery at boot
└── package.json
```

---

## 2. Dependency Injection & Provider Pattern

Tất cả các dịch vụ AI và phương thức ngoại vi được trừu tượng hóa và đăng ký tập trung qua `backend/src/providers/registry.js`.

- Mọi lời gọi AI đều đi qua `callProvider()` (`backend/src/lib/callProvider.js`), tự động áp dụng:
  1. **Rate Limiting** (Token Bucket + Sliding Window).
  2. **Provider Cache** (bộ nhớ đệm SHA-256 đầu vào, TTL 90 ngày).
  3. **Tracking & Observability** (ghi log cuộc gọi vào `provider_logs`).
  4. **Failover** (`withProviderFailover`): Tự động chuyển đổi provider dự phòng khi gặp lỗi.

---

## 3. Các Luồng Pipeline (Application Layer — `runner.js`)

`backend/src/pipeline/runner.js` điều phối 4 pipeline theo chế độ:

### 3.1. `MEDIA_COMPOSER` (Flagship — Biên tập Video Đa phương tiện & Đa rãnh)
Gồm 3 công đoạn tối ưu:
```
composer.ingest ➔ composer.prepare ➔ composer.render
```
- **`composer.ingest`**: Kiểm tra tính hợp lệ của tài nguyên ảnh, audio tải lên. Nếu timeline chưa có clip, tự động kích hoạt `autoArrangeTimeline` để xếp đặt các phân đoạn vào rãnh `MAIN_VIDEO`, tính toán `target_duration_sec`.
- **`composer.prepare`**: Chuẩn hoá hình ảnh (scale/pad theo aspect ratio `16:9` hoặc `9:16`), chuẩn hoá âm thanh (resample 48kHz stereo), và biên dịch phụ đề sang file ASS UTF-8 Unicode-safe (`\fn`, `\c`, `\fs`).
- **`composer.render`**: Dựng video đa lớp qua FFmpeg filtergraph:
  - Lớp hình ảnh: Background làm mờ + Slideshow zoom nhẹ 1.05x + Lớp overlay.
  - Lớp âm thanh: Lặp vô tận nhạc nền BGM (`aloop`), áp dụng dynamic sidechain ducking (-12dB) khi có tiếng voiceover.
  - Phụ đề: Burn-in phụ đề ASS chất lượng cao, probe ffprobe và lưu trữ output.

### 3.2. `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng)
Gồm 7 công đoạn:
```
dub.ingest ➔ dub.stt ➔ dub.merge ➔ dub.translate ➔ dub.mask ➔ dub.ttsAlign ➔ dub.render
```
- **STT-Only Extraction**: Trích xuất lời thoại bằng Whisper ASR kèm xử lý overlap stitching 15s giữa các chunk và lọc ảo giác.
- **TransFlow Multi-Round Translation**: Dịch 3 vòng (Parallel Batch → Rescue Batch → Single Fallback), hỗ trợ 13 StylePresets và kiểm soát rò rỉ CJK.
- **Subtitle Masking (`dub.mask`)**: Tự động nhận diện khung chứa hardsub bằng Vision hoặc nạp mask người dùng vẽ tay trên Canvas. Mask `APPROVED` là bất biến khi đưa vào render.
- **Forced Alignment TTS (`dub.ttsAlign`)**: Ép khớp thời lượng giọng lồng tiếng AI vào slot thời gian của câu gốc:
  - `TEMPO_MAX = 1.35`: Tốc độ co dãn tối đa giữ ở 1.35x để bảo toàn cao độ giọng nói tự nhiên.
  - **Pause-expansion**: Tận dụng khoảng lặng trước câu kế tiếp (`roomDur = Math.max(slotDur, nextStart - 0.06 - startSec)`) để giọng đọc không bị ép tăng tốc giả.
  - **Silence trimming**: Dùng FFmpeg `silenceremove` cắt 100-300ms im lặng thừa trước và sau câu thoại.
- **Dynamic Sidechain Ducking**: Nén nhạc nền -12dB khi có giọng lồng tiếng và phục hồi 100% âm lượng khi im lặng; phụ đề ASS dịch được burn ở đáy khung hình (`\an2`).

### 3.3. `SCRIPT_TO_VIDEO` (Tạo video từ kịch bản)
Gồm 7 công đoạn:
```
script.ingest ➔ script.analyze ➔ script.tts ➔ script.image ➔ script.align ➔ script.subtitle ➔ script.render
```
- **Ingest & Integrity**: Kiểm tra tính toàn vẹn của tệp kịch bản `.txt` qua băm SHA-256 (`script_hash`), lưu trữ cục bộ tại `script/source.txt`.
- **Script Analyze**: Phân tách kịch bản thành các `script_segments` gồm câu thoại thuyết minh và mô tả thị giác (visual prompt). Hỗ trợ fallback phân đoạn ngữ pháp nếu LLM không trả JSON hợp lệ.
- **Review Gate (`script_review_required = 1`)**: Pipeline tự động dừng lại ở trạng thái `queued` sau bước phân tích để người dùng xem trước và tinh chỉnh kịch bản trước khi sinh media.
- **TTS & SlideImage**: Sinh audio giọng đọc cho từng phân đoạn và tạo ảnh slide minh họa tương ứng.
- **Align & Render**: Căn thời lượng ảnh khớp chính xác với giọng đọc và render video MP4 hoàn chỉnh.

### 3.4. `SUMMARY` (Legacy — Review phim & Video tóm tắt)
Gồm 8 công đoạn tuần tự:
```
summary.transcribe ➔ summary.sceneDetect ➔ summary.analyze ➔ summary.script ➔ summary.align ➔ summary.tts ➔ summary.subtitle ➔ summary.render
```
- **AlignService**: Lấy thời lượng đọc chính xác `durationSec` của lời review từ TTS làm chuẩn, đóng gói các cảnh quay (`scenes`) thành các `timeline_clips` có thời lượng tương ứng (sai lệch < 1s).
- **FFmpeg Concat & Ducking**: Ghép các clip cảnh, chèn hiệu ứng chuyển cảnh, lồng tiếng review và xuất video MP4.

---

## 4. Các Dịch vụ Cốt lõi (Core Services)

| Service | Vai trò |
| --- | --- |
| `composerService.js` | Quản lý 5 rãnh timeline, tải lên/sắp xếp assets, OCR 2-tier cache, translate 2-tier cache, sinh TTS voiceover, auto-arrange timeline và lưu cấu trúc timeline |
| `resumableUploadService.js` | Quản lý tải lên phân đoạn TUS-like (chunk 8MB, limit 2GB), tự phục hồi session khi khởi động lại máy chủ |
| `scriptService.js` / `scriptUploadService.js` | Chuẩn hoá văn bản kịch bản, chunking, phân đoạn LLM, kiểm tra băm SHA-256 |
| `projectAdmission.js` | Quản lý quyền sở hữu phiên chạy (`run_token`), lease timeout, kiểm tra giới hạn concurrency (`MAX_CONCURRENT_PROJECTS_PER_USER`) |
| `transcriptMutationService.js` | Cập nhật câu dịch/thời gian, tự động tăng `transcript_version` và đồng bộ cờ `outputStale` |
| `quotaGuardService.js` | Kiểm tra giới hạn hạn mức API của các provider trước khi chạy stage, cảnh báo cạn quota |
| `zeroTtsSupervisor.js` | Quản lý vòng đời sidecar Python ZeroTTS trong môi trường phát triển (`npm run dev`) |
| `projectCleanup.js` | Quản lý tác vụ dọn dẹp ổ đĩa qua outbox durable tasks (`project_cleanup_tasks`) |
| `youtubeOAuthService.js` & `youtubePublishService.js` | Xử lý xác thực PKCE OAuth với Google và tải video lên YouTube |
| `emailService.js` | Gửi email thông báo hoàn thành dự án và mã xác thực OTP qua SMTP Nodemailer |

### 4.1. Router & Lưu trữ Media Composer
- **Router REST `backend/src/routes/v1/composerAssets.js`**: Cung cấp 8 endpoints chuyên biệt cho tải lên asset, reorder, OCR, translate, TTS, auto-arrange và lưu timeline tracks/clips.
- **Cấu trúc lưu trữ Asset**: Toàn bộ tài nguyên ảnh và âm thanh được lưu trữ phân lập theo dự án tại thư mục `storage/projects/:id/assets/` với đường dẫn an toàn qua `createSafeMediaStatic`.

---

## 5. Cơ sở dữ liệu & Quản lý Trạng thái Lưu trữ (sql.js)

- **In-Memory + Disk Atomic Snapshots**: `sql.js` nạp toàn bộ dữ liệu vào RAM để truy vấn siêu nhanh; mọi đột biến ghi được tuần tự hóa qua hàng đợi `query.js` và flush ra tệp `backend/data.db` bằng snapshot atomic.
- **Single-Writer Lock (`data.db.writer.lock`)**: File lock ghi nhận PID và hostname của tiến trình sở hữu, ngăn chặn hai tiến trình ghi đè làm hỏng database.
- **Persistence Health Monitoring**:
  - `HEALTHY`: Quá trình ghi đĩa diễn ra bình thường.
  - `DEGRADED`: Xuất hiện lỗi ghi đĩa tạm thời nhưng chưa vượt ngưỡng tối đa.
  - `WRITE_BLOCKED`: Quá số lần ghi lỗi cho phép; máy chủ tự động chặn mọi thao tác ghi mới và endpoint `/ready` trả về HTTP 503 để bảo vệ dữ liệu.

---

## 6. Xử lý Lỗi & Khả năng Chịu lỗi (Resilience)

1. **Phân loại lỗi**:
   - **Lỗi Dữ liệu (Validation)**: `TRANSLATE_NEEDS_REVIEW`, `BLOCK_RENDER` — fail-fast ngay lập tức, không retry mù; người dùng chỉnh sửa dữ liệu trên giao diện rồi nhấn Regenerate.
   - **Lỗi Tạm thời (Transient)**: 503, timeout mạng — retry tự động theo `RETRY_POLICY` với exponential backoff.
   - **Lỗi Hạn mức (Rate Limit / 429)**: Trích xuất `Retry-After`, đặt trạng thái project là `queued` và hẹn giờ thử lại tại `next_retry_at` (`parkProjectForRetry`).
2. **Khôi phục phiên chạy dở dang (`recoverStaleProjects`)**: Tự động chuyển các dự án bị kẹt `running` do server crash/restart về `queued` để tiếp tục từ stage dở dang sớm nhất (`firstRunnableStage`).
3. **Huỷ an toàn (`cancelProjectUseCase`)**: Kích hoạt `AbortController` để ngắt các tiến trình đang thực thi, chuyển trạng thái project sang `cancelled` và thu hồi tài nguyên tạm.
