# 00 — Tầm nhìn và Yêu cầu

## 1. Tầm nhìn (Project Vision)

**AI Shorts Factory** là nền tảng SaaS giúp người dùng biến nội dung dài hoặc bộ assets rời rạc
thành video hoàn chỉnh, được AI sản xuất **tự động**, mà không cần kỹ năng edit.

Hệ thống phục vụ hai nhóm use-case:

- **Người làm nội dung review phim:** có 1 bộ phim dài 2–3 tiếng, muốn có 1 video review 20–30 phút
  có giọng đọc nhận xét, với các cảnh trích từ phim gốc được cắt ghép khớp với lời review.
- **Người làm video ngắn theo phong cách:** có ảnh/video/âm thanh rời rạc và 1 video mẫu, muốn có
  video ngắn 30s–1phút được edit y hệt phong cách của video mẫu.

### Mục tiêu chất lượng (Success Metrics)

- Tỷ lệ pipeline chạy thành công end-to-end ≥ 95%.
- Đồng bộ giọng đọc ↔ cảnh trong mode `SUMMARY` sai lệch < 1 giây mỗi đoạn.
- Thời gian sản xuất (2–3h phim → 25 phút review) < 30 phút trên cấu hình đề xuất.
- Thêm 1 provider AI mới không yêu cầu sửa business logic.
- Triển khai production chỉ bằng `docker compose up`.

---

## 2. Phạm vi (Scope)

### 2.1. Trong phạm vi

- Hai mode: `SUMMARY` (review phim) và `STYLE_EDIT` (edit theo mẫu).
- Upload phim / assets / video mẫu qua dashboard.
- Pipeline AI tự động: transcribe, scene-detect, script review, align, TTS, subtitle, render.
- Hàng đợi nền (BullMQ) với retry tự động.
- Dashboard theo dõi tiến trình, xem kết quả, quản lý provider/API key.
- Xuất video và (tuỳ chọn) đẩy YouTube.

### 2.2. Ngoài phạm vi (MVP)

- Không có editor timeline thủ công (theo yêu cầu tự động hoàn toàn).
- Không hỗ trợ live-streaming.
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

### 3.3. Mode `STYLE_EDIT` — Edit theo mẫu

| Mã | Chức năng |
| --- | --- |
| FR-E1 | Upload assets (ảnh, video, audio) + 1 video mẫu |
| FR-E2 | Phân tích video mẫu → `StyleProfile` (transition, nhịp, màu, motion, text) |
| FR-E3 | Sinh storyboard từ assets áp dụng `StyleProfile` |
| FR-E4 | (Tuỳ chọn) TTS lời dẫn/nhận xét |
| FR-E5 | Render video 30s–1phút theo phong cách mẫu |
| FR-E6 | (Tuỳ chọn) Đẩy YouTube |

### 3.4. Quản trị & quan sát

- Dashboard: widget video đã sinh, credit đã dùng, trạng thái queue, storage, provider status.
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
| NFR-8 | **Performant** — xử lý phim 2–3h song song chunk, transcode mezzanine |
| NFR-9 | **i18n** — đa ngôn ngữ cho cả giọng đọc và UI |

---

## 5. Định nghĩa từ khoá

- **Scene:** một đoạn phim gốc liên tục giữa hai điểm cắt cảnh (cut).
- **ScriptSegment:** một đoạn lời review trong kịch bản, có thời lượng mục tiêu.
- **TimelineClip:** bản ghi một clip đã được căn giờ (in/out, speed, transition) thuộc timeline xuất.
- **StyleProfile:** tập hợp tham số phong cách trích xuất từ video mẫu.
- **Align:** thuật toán đồng bộ lời review với cảnh phim (xem `05_THIET_KE_PIPELINE_CHI_TIET.md`).
