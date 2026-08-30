# 00 — Tầm nhìn và Yêu cầu

## 1. Tầm nhìn (Project Vision)

**AI Shorts Factory** là nền tảng SaaS giúp người dùng biến nội dung dài hoặc bộ assets rời rạc
thành video hoàn chỉnh, được AI sản xuất **tự động**, mà không cần kỹ năng edit.

Hệ thống phục vụ hai nhóm use-case:

- **Người làm nội dung review phim:** có 1 bộ phim dài 2–3 tiếng, muốn có 1 video review 20–30 phút
  có giọng đọc nhận xét, với các cảnh trích từ phim gốc được cắt ghép khớp với lời review.
- **Người làm nội dung dịch & lồng tiếng:** có 1 video nước ngoài (phim ngắn, anime, vlog... thường
  5–60 phút, kèm phụ đề cứng/hardsub), muốn có bản **dịch tiếng Việt theo phong cách tuỳ chọn**
  (cổ trang, bắt trend, review phim...), tuỳ chọn lồng giọng AI — giữ nguyên hình ảnh gốc.

### Mục tiêu chất lượng (Success Metrics)

- Tỷ lệ pipeline chạy thành công end-to-end ≥ 95%.
- Đồng bộ giọng đọc ↔ cảnh trong mode `SUMMARY` sai lệch < 1 giây mỗi đoạn.
- Forced alignment dub trong mode `TRANSLATE_DUB` lệch slot gốc < 5% mỗi câu, không chồng tiếng.
- Thời gian sản xuất (2–3h phim → 25 phút review) < 30 phút trên cấu hình đề xuất.
- Thêm 1 provider AI mới không yêu cầu sửa business logic.
- Triển khai production chỉ bằng `docker compose up`.

---

## 2. Phạm vi (Scope)

### 2.1. Trong phạm vi

- Hai mode: `SUMMARY` (review phim) và `TRANSLATE_DUB` (dịch thuật & lồng tiếng).
- Upload phim (SUMMARY) / video cần Việt hoá ≤ 2GB (TRANSLATE_DUB) qua dashboard,
  dùng **resumable upload** (chunk 5–10MB, kiểu TUS) chống rớt mạng.
- Pipeline AI tự động: SUMMARY — transcribe, scene-detect, script review, align, TTS, subtitle,
  render; TRANSLATE_DUB — STT & OCR hardsub **song song**, dịch LLM theo 13 phong cách,
  TTS + forced alignment (tuỳ chọn), masking/inpainting, burn-in, audio mix, mux.
- Dashboard theo dõi tiến trình **real-time qua SSE**, xem kết quả, quản lý provider/API key.
- Trình chỉnh vùng che chữ (khoanh vùng hardsub) trực tiếp trên trình duyệt (Canvas API).
- Xuất video và (tuỳ chọn) đẩy YouTube.

### 2.2. Ngoài phạm vi (MVP)

- Không có editor timeline thủ công (theo yêu cầu tự động hoàn toàn; riêng TRANSLATE_DUB chỉ cho
  chỉnh **vùng che chữ**, không chỉnh timeline).
- Không hỗ trợ live-streaming.
- Không có hệ thống thanh toán / ví điểm thưởng — mọi tính năng mở cho user đã đăng nhập.
- PostgreSQL chỉ bật ở bản production (MVP dùng SQLite).
- Upload YouTube dùng OAuth thủ công của user (không auto-publish không kiểm soát).

---

## 3. Yêu cầu chức năng (Functional Requirements)

### 3.1. Quản lý người dùng & auth

- Đăng ký / đăng nhập / làm mới token (JWT access + refresh).
- Phân quyền: `USER`, `ADMIN`, `GUEST`.
- Quản lý API key riêng của user cho từng provider (mã hoá tại rest).

### 3.2. Mode `SUMMARY` — Review phim

| Mã | Chức năng |
| --- | --- |
| FR-S1 | Upload 1 bộ phim (2–3h), xác thực định dạng & kích thước |
| FR-S2 | Tự động tách audio & nhận diện ngôn ngữ |
| FR-S3 | Transcribe toàn bộ phim → transcript có timestamp (ASR) |
| FR-S4 | Phát hiện cảnh (scene detection) → danh sách cảnh có thời gian & thumbnail |
| FR-S5 | Sinh kịch bản review có cấu trúc (LLM): từng đoạn có lời review + cảnh tham chiếu |
| FR-S6 | TTS lời review → giọng đọc (đa ngôn ngữ) |
| FR-S7 | **Align**: ghép lời review với cảnh phim sao cho khớp thời lượng |
| FR-S8 | Sinh phụ đề khớp giọng đọc |
| FR-S9 | Render video 20–30 phút (ghép cảnh, transition, voice, subtitle, intro/outro) |
| FR-S10 | (Tuỳ chọn) Đẩy YouTube |

### 3.3. Mode `TRANSLATE_DUB` — Dịch thuật & Lồng tiếng

| Mã | Chức năng |
| --- | --- |
| FR-T1 | Upload video (≤ 2GB) resumable (chunk 5–10MB, kiểu TUS), xác thực định dạng & kích thước |
| FR-T2 | Demux FFmpeg: tách audio/video; chuẩn hoá âm lượng LUFS cho STT |
| FR-T3 | STT: transcript + word timestamps + speaker diarization (nhiều nhân vật) |
| FR-T4 | OCR hardsub: frame sampling 1–2 fps → bounding box + text gốc theo từng mốc thời gian |
| FR-T5 | Dịch LLM gom theo context window, routing 1 trong 13 StylePreset (văn phong/xưng hô/slang) |
| FR-T6 | Sinh phụ đề đích (SRT/VTT/ASS) đồng bộ timestamp gốc |
| FR-T7 | (Tuỳ chọn) TTS lồng tiếng + forced alignment khớp slot thời gian gốc |
| FR-T8 | Che phụ đề gốc: blur / fill màu nền / AI inpainting theo bounding box. ⚠️ `blur` và `fill` là phương pháp **mặc định** (nhanh, nhẹ, không gọi thêm provider); `inpaint` là **tùy chọn nâng cao (premium)** — yêu cầu gọi thêm Vision/Inpainting Provider, thời gian render lâu hơn và có thể phát sinh chi phí API cao hơn |
| FR-T9 | Burn-in phụ đề mới + audio mix (dub voice + nền) + mux MP4/MKV (NVENC) |
| FR-T10 | Tiến trình real-time qua SSE; chỉnh vùng che chữ trên Canvas trước render |

### 3.4. Quản trị & quan sát

- Dashboard: widget video đã sinh, trạng thái queue, storage, provider status.
- Trang: Projects, Project Detail (xem timeline + player), Queue, Outputs, Settings, Provider Settings, API Keys, Logs, Analytics, Admin.
- Xem log cuộc gọi AI (ProviderLog) và lỗi.

---

## 4. Yêu cầu phi chức năng (Non-functional Requirements)

| Mã | Yêu cầu |
| --- | --- |
| NFR-1 | **Maintainable** — Clean Architecture, module tách biệt, không code trùng lặp |
| NFR-2 | **Secure** — JWT, refresh rotate, mã hoá API key, RBAC, không hardcode secret |
| NFR-3 | **Extensible** — Provider Pattern; thêm provider/mode không sửa core |
| NFR-4 | **Observable** — logging集中 (Pino) + ProviderLog + metrics |
| NFR-5 | **Testable** — unit/integration test, mock provider |
| NFR-6 | **Scalable** — BullMQ worker scale ngang, storage abstraction (local/S3) |
| NFR-7 | **Resilient** — retry, idempotency, continuation từ job thất bại |
| NFR-8 | **Performant** — xử lý phim 2–3h song song chunk, transcode mezzanine; STT/OCR chạy song song; render tăng tốc NVENC |
| NFR-9 | **i18n** — đa ngôn ngữ cho cả giọng đọc và UI |
| NFR-10 | **Real-time UX** — tiến trình job đẩy qua SSE/WebSocket, không cần refresh |
| NFR-11 | **Upload bền** — resumable upload (chunk, kiểu TUS) cho file ≤ 2GB, resume sau rớt mạng |

---

## 5. Định nghĩa từ khoá

- **Scene:** một đoạn phim gốc liên tục giữa hai điểm cắt cảnh (cut).
- **ScriptSegment:** một đoạn lời review trong kịch bản, có thời lượng mục tiêu.
- **TimelineClip:** bản ghi một clip đã được căn giờ (in/out, speed, transition) thuộc timeline xuất.
- **Align:** thuật toán đồng bộ lời review với cảnh phim (xem `05_THIET_KE_PIPELINE_CHI_TIET.md`).
- **Hardsub:** phụ đề được "đốt" sẵn vào hình ảnh video gốc, không tách rời được như softsub.
- **TranscriptSegment:** một câu/đoạn thoại do STT nhận dạng, có start/end, text và speaker.
- **OcrRegion:** vùng chữ hardsub `{x, y, width, height}` tồn tại trong khoảng `[startSec, endSec]`,
  do OCR tự phát hiện hoặc user khoanh vùng tay trên Canvas.
- **StylePreset:** 1 trong 13 phong cách dịch định nghĩa trước (system prompt + mô tả), quyết định
  văn phong/xưng hô của bản dịch.
- **Forced Alignment:** ép khớp thời lượng giọng TTS vào slot thời gian của câu gốc
  (tempo stretching / chèn lặng / rút gọn câu).
