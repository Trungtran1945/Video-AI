# 10 — Lộ trình Triển khai & Trạng thái Công việc (Roadmap & Tasks)

Tài liệu theo dõi trạng thái cài đặt thực tế của các tính năng trong dự án Video-AI.

> **Quy ước nhãn**:
> - `[DONE]`: Đã cài đặt hoàn chỉnh và có kiểm thử bảo vệ.
> - `[PARTIAL]`: Đã cài đặt một phần (hoặc backend đã có nhưng frontend chưa khai thác hết).
> - `[PLANNED]`: Mục tiêu nâng cấp trong tương lai (Postgres, S3 storage, v.v.).

---

## Giai đoạn 1 — Nền tảng Kiến trúc Cốt lõi
- `[DONE]` Hệ thống cơ sở dữ liệu `sql.js` (WebAssembly SQLite) 29 bảng, lưu tệp `backend/data.db`, atomic snapshot memory-disk và single-writer lock (`data.db.writer.lock`).
- `[DONE]` Hệ thống xác thực JWT (Access token ngắn hạn + HttpOnly cookie `refresh_token` xoay vòng CAS, phân quyền USER / ADMIN).
- `[DONE]` Quên mật khẩu & xác thực mã OTP qua email (`reset_tokens`, `email_otps`, Nodemailer SMTP).
- `[DONE]` Kiến trúc Provider Pattern (`backend/src/providers/registry.js`, `callProvider.js`) hỗ trợ LLM, ASR, TTS, Vision, Image.
- `[DONE]` Cơ chế Rate Limiting (Token Bucket + Sliding Window) theo từng provider/tier + bộ nhớ đệm `provider_cache` băm SHA-256 (TTL 90 ngày).
- `[DONE]` Provider Mock (`mockAsr`, `mockLlm`, `mockTts`, `mockVision`) hỗ trợ dev/CI hoàn toàn độc lập, không tốn quota API thật.
- `[DONE]` Kiểm soát giới hạn số dự án chạy đồng thời (`MAX_CONCURRENT_PROJECTS_PER_USER`, mặc định 2 project `running`), xếp hàng `queued` khi vượt ngưỡng.
- `[DONE]` Bắt buộc xác nhận bản quyền nội dung (`copyrightAcknowledged = true`) trước khi khởi chạy pipeline.

---

## Giai đoạn 2 — Pipeline SUMMARY (Review phim & Video tóm tắt)
- `[DONE]` `summary.transcribe`: Tách audio chuẩn 16kHz mono và nhận dạng lời thoại toàn bộ phim qua Whisper ASR.
- `[DONE]` `summary.sceneDetect`: Shot detection tự động bằng FFmpeg và xuất thumbnail cảnh quay.
- `[DONE]` `summary.analyze`: Phân tích ngữ nghĩa hình ảnh và bối cảnh các cảnh quay qua Gemini Vision.
- `[DONE]` `summary.script`: LLM sinh kịch bản review có cấu trúc lời bình (`narration`) và liên kết cảnh (`sceneRefs`).
- `[DONE]` `summary.align`: Thuật toán AlignService đóng gói các cảnh quay khớp chính xác với thời lượng đọc của TTS (dung sai < 1s).
- `[DONE]` `summary.tts` & `summary.subtitle`: Tổng hợp giọng đọc thuyết minh và sinh phụ đề ASS/SRT đồng bộ.
- `[DONE]` `summary.render`: FFmpeg ghép mezzanine, hiệu ứng chuyển cảnh `xfade`, lồng tiếng và kết xuất video MP4 1080p.

---

## Giai đoạn 3 — Pipeline TRANSLATE_DUB (Dịch thuật & Lồng tiếng video)
- `[DONE]` Tải lên Resumable upload chuẩn TUS-like: Phân đoạn chunk 8MB (giới hạn file 2GB), tự phục hồi session tải lên sau mất mạng hoặc restart máy chủ.
- `[DONE]` `dub.ingest`: Demux luồng audio/video và chuẩn hóa âm lượng EBU R128 (`loudnorm` -16 LUFS).
- `[DONE]` `dub.stt`: Whisper ASR trích xuất câu thoại kèm mốc thời gian, xử lý overlap stitching 15s giữa các chunk và lọc ảo giác.
- `[DONE]` `dub.merge`: Barrier kiểm tra tính toàn vẹn dữ liệu transcript trước khi dịch.
- `[DONE]` `dub.translate`: Dịch thuật LLM theo 13 StylePresets dựng sẵn, chiến lược 3 vòng (TransFlow) chống mất câu, lọc rò rỉ chữ Hán CJK và tự sửa lỗi ngữ nghĩa.
- `[DONE]` `dub.mask`: Tự động phát hiện khung chứa hardsub bằng Vision hoặc nhận diện mask người dùng; lưu vào `ocr_regions` với lifecycle `DRAFT`, `APPROVED`, `DISABLED`.
- `[DONE]` `dub.ttsAlign`: TTS lồng tiếng + Forced Alignment:
  - Khống chế tốc độ co dãn `TEMPO_MAX = 1.35` để bảo toàn cao độ giọng nói tự nhiên.
  - Mở rộng pause-expansion vào khoảng lặng câu kế tiếp để giữ tempo tự nhiên 1.0x.
  - Cắt khoảng lặng thừa đầu/cuối bằng `silenceremove`.
- `[DONE]` `dub.render`: Burn mask `APPROVED` (boxblur/drawbox) + Burn phụ đề ASS neo đáy (`\an2`) + Dynamic Sidechain Ducking (-12dB khi có giọng nói) + Mux MP4 NVENC/x264.
- `[DONE]` Trình chỉnh sửa phụ đề song ngữ (Bilingual Transcript Editor) với optimistic concurrency (`transcript_version`), audio preview và nút Lồng tiếng lại (`Redub`).
- `[DONE]` Trình vẽ vùng che hardsub `MaskEditor.jsx` trên Canvas với cơ chế khoá sửa mask APPROVED (`MASK_APPROVED_IMMUTABLE`).

---

## Giai đoạn 4 — Pipeline SCRIPT_TO_VIDEO (Tạo video từ kịch bản)
- `[DONE]` Tải lên kịch bản qua `POST /api/v1/script-uploads` (tệp `.txt` hoặc paste văn bản, kiểm tra băm SHA-256).
- `[DONE]` `script.ingest`: Chuẩn hóa văn bản, đếm ký tự và lưu trữ kịch bản nguồn an toàn.
- `[DONE]` `script.analyze`: LLM phân đoạn kịch bản thành `script_segments` (lời đọc + visual prompt), có fallback quy tắc ngữ pháp xác định.
- `[DONE]` Review Gate: Dự án tự động tạm dừng tại `script_review_required = 1` để người dùng duyệt và sửa phân đoạn kịch bản trên giao diện trước khi sinh media.
- `[DONE]` `script.tts`: Sinh audio giọng đọc thuyết minh AI cho từng phân đoạn kịch bản.
- `[DONE]` `script.image`: Sinh hình ảnh slide minh họa qua `slideImage.js` theo tỷ lệ `16:9` hoặc `9:16`.
- `[DONE]` `script.align`: Căn chỉnh thời lượng hình ảnh slide khớp chính xác với thời lượng đọc của audio.
- `[DONE]` `script.subtitle` & `script.render`: Sinh phụ đề ASS và render video MP4 hoàn chỉnh kèm hiệu ứng Ken-Burns và nhạc nền.

---

## Giai đoạn 5 — Vận hành, Giám sát & Mở rộng
- `[DONE]` Cập nhật tiến độ realtime qua Server-Sent Events (SSE) dùng vé xác thực một lần ngắn hạn (`sse-ticket`).
- `[DONE]` Huỷ an toàn pipeline (`POST /projects/:id/cancel` via `AbortController`, chuyển status `cancelled`).
- `[DONE]` Chạy lại pipeline linh hoạt (`POST /projects/:id/regenerate` từ `firstRunnableStage` hoặc từ `fromStage` chọn lọc).
- `[DONE]` Tự phục hồi sau khởi động lại máy chủ (`recoverStaleProjects`, `recoverUploadSessions`).
- `[DONE]` Durable cleanup outbox tasks (`project_cleanup_tasks` và `cleanupWorker`).
- `[DONE]` Quản lý đa API key (Gemini, OpenAI, ElevenLabs) với thanh giám sát Quota Free Tier.
- `[DONE]` Tích hợp sidecar ZeroTTS Python trong môi trường phát triển cục bộ (`npm run dev`).
- `[DONE]` Liên kết tài khoản YouTube qua Google OAuth (PKCE) và xuất bản video.
- `[DONE]` Thông báo hoàn thành/thất bại qua email bằng Nodemailer SMTP.
- `[PLANNED]` Nâng cấp cơ sở dữ liệu lên PostgreSQL khi cần triển khai đa node worker song song.
- `[PLANNED]` Lưu trữ đối tượng S3/MinIO cho volume media phân tán.
