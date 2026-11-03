# 00 — Tầm nhìn và Yêu cầu

## 1. Tầm nhìn (Project Vision)

**AI Shorts Factory (Video-AI)** là nền tảng SaaS giúp người dùng biến nội dung dài, video ngoại ngữ hoặc văn bản kịch bản thô thành video hoàn chỉnh, được AI sản xuất **tự động**, mà không cần kỹ năng dựng video timeline phức tạp.

Hệ thống phục vụ ba nhóm use-case chính:

- **Người làm nội dung review phim / tóm tắt:** Có 1 bộ phim / tài liệu dài 2–3 tiếng, muốn có 1 video review 20–30 phút có giọng đọc nhận xét AI, với các cảnh trích từ phim gốc được cắt ghép khớp chính xác với lời review qua thuật toán Align.
- **Người làm nội dung dịch thuật & lồng tiếng:** Có 1 video nước ngoài (anime, vlog, phim ngắn... ≤ 2GB, kèm hardsub), muốn dịch phụ đề tiếng Việt tự nhiên theo 1 trong **13 phong cách dịch**, tuỳ chọn lồng tiếng AI ép khớp timestamp gốc (Forced Alignment TTS), tự động che hardsub gốc và giữ nguyên hình ảnh gốc.
- **Người sáng tạo nội dung từ kịch bản (Script to Video):** Có kịch bản văn bản (upload tệp `.txt` hoặc paste nội dung), muốn tự động chuyển hóa thành video hoàn chỉnh có thuyết minh AI, hình ảnh slide minh hoạ đồng bộ, phụ đề động và kết xuất MP4 sẵn sàng xuất bản.

### Mục tiêu chất lượng (Success Metrics)

- Tỷ lệ pipeline chạy thành công end-to-end ≥ 95%.
- Đồng bộ giọng đọc ↔ cảnh trong mode `SUMMARY` sai lệch < 1 giây mỗi đoạn.
- Forced alignment dub trong mode `TRANSLATE_DUB` lệch slot gốc < 5% mỗi câu, không chồng tiếng, không sóc chuột (`TEMPO_MAX = 1.35`).
- Thời gian sản xuất (2–3h phim → 25 phút review) < 30 phút trên cấu hình đề xuất.
- Thêm 1 provider AI mới không yêu cầu sửa business logic core (Provider Pattern).
- Triển khai production tinh gọn chỉ bằng `docker compose up`.

---

## 2. Phạm vi (Scope)

### 2.1. Trong phạm vi

- Ba mode sản xuất video: `SUMMARY` (review phim), `TRANSLATE_DUB` (dịch & lồng tiếng) và `SCRIPT_TO_VIDEO` (tạo video từ kịch bản).
- Upload phim (SUMMARY) / video cần Việt hoá ≤ 2GB (TRANSLATE_DUB) qua dashboard, dùng **resumable upload chuẩn TUS-like** (chunk 8MB cố định, limit 2GB) chống rớt mạng. File vượt quá 2GB bị từ chối ngay từ API, không enqueue để tránh lãng phí tài nguyên.
- Upload tệp kịch bản (`.txt`) cho chế độ `SCRIPT_TO_VIDEO`, kiểm tra toàn vẹn mã băm SHA-256 (`script_hash`) và quản lý phiên bản kịch bản (`script_version`).
- Pipeline AI tự động:
  - **`SUMMARY` (8 stages)**: `summary.transcribe → summary.sceneDetect → summary.analyze → summary.script → summary.align → summary.tts → summary.subtitle → summary.render`.
  - **`TRANSLATE_DUB` (7 stages)**: `dub.ingest → dub.stt → dub.merge → dub.translate → dub.mask → dub.ttsAlign → dub.render`. STT-only extraction (Whisper ASR + 15s overlap stitching), 13 phong cách dịch LLM (TransFlow 3 vòng), TTS + Forced Alignment, Subtitle Masking tự động hoặc chỉnh tay trên Canvas (với trạng thái DRAFT / APPROVED / DISABLED, APPROVED là bất biến), Burn-in phụ đề ASS ở đáy khung hình (`\an2`), Dynamic sidechain ducking (-12dB).
  - **`SCRIPT_TO_VIDEO` (7 stages)**: `script.ingest → script.analyze → script.tts → script.image → script.align → script.subtitle → script.render`. Hỗ trợ review gate (`script_review_required = 1`) sau phân đoạn để user duyệt kịch bản trước khi render.
- Dashboard theo dõi tiến trình **real-time qua SSE** (`GET /projects/:id/events` dùng vé tạm `sse-ticket`), xem kết quả, quản lý provider/API key.
- Trình chỉnh sửa phụ đề song ngữ (Bilingual Transcript Editor) với optimistic concurrency (`transcript_version`), audio preview và redubbing.
- Trình chỉnh vùng che chữ (MaskEditor) trực tiếp trên trình duyệt bằng HTML5 Canvas.
- Xuất video hoàn chỉnh và hỗ trợ tích hợp kết nối YouTube OAuth.

### 2.2. Ngoài phạm vi (MVP)

- Không có trình dựng timeline video kéo thả thủ công (video splicing/trimming editor đa track như Premiere/CapCut). Tuy nhiên, hỗ trợ điều chỉnh thủ công thời gian (start/end) và nội dung của từng đoạn thoại trong `TRANSLATE_DUB` và `SCRIPT_TO_VIDEO`.
- Không hỗ trợ live-streaming.
- Không có hệ thống thanh toán / ví điểm thưởng — mọi tính năng mở cho user đã đăng nhập.
- Database: Hiện tại sử dụng `sql.js` (WebAssembly SQLite với file lưu trữ `backend/data.db` và single-writer lock); PostgreSQL là hướng nâng cấp khi scale ngang.
- Không tự động kiểm duyệt bản quyền nội dung nguồn (xem §5 — trách nhiệm thuộc về user).
- Giới hạn concurrency kỹ thuật: Mặc định tối đa 2 project `running` đồng thời / user (`MAX_CONCURRENT_PROJECTS_PER_USER`), các project vượt ngưỡng sẽ nằm ở trạng thái `queued`.

---

## 3. Yêu cầu chức năng (Functional Requirements)

### 3.1. Quản lý người dùng & auth

- Đăng ký / đăng nhập / làm mới token (JWT access token + HttpOnly refresh cookie với cơ chế xoay vòng CAS).
- Xác thực qua OTP email (`email_otps`) và tính năng quên mật khẩu / reset mật khẩu (`reset_tokens`).
- Phân quyền: `USER`, `ADMIN`.
- Quản lý API key riêng của user cho từng provider (mã hóa tại rest bằng `MASTER_KEY` AES-256-GCM).

### 3.2. Mode `SUMMARY` — Review phim & Tóm tắt

| Mã | Chức năng |
| --- | --- |
| FR-S1 | Upload 1 bộ phim (2–3h, ≤ 2GB), xác thực định dạng & kích thước |
| FR-S2 | Tự động tách audio & nhận diện ngôn ngữ |
| FR-S3 | Transcribe toàn bộ phim → transcript có timestamp (ASR Whisper) |
| FR-S4 | Phát hiện cảnh (scene detection) → danh sách cảnh có thời gian & thumbnail |
| FR-S5 | Sinh kịch bản review có cấu trúc (LLM): từng đoạn có lời review + cảnh tham chiếu |
| FR-S6 | TTS lời review → giọng đọc thuyết minh |
| FR-S7 | **Align**: Ghép lời review với cảnh phim sao cho khớp thời lượng chính xác |
| FR-S8 | Sinh phụ đề ASS/SRT khớp giọng đọc |
| FR-S9 | Render video 20–30 phút (ghép cảnh, transition, voice, subtitle, intro/outro) |
| FR-S10 | Xuất video và (tuỳ chọn) đẩy YouTube |

### 3.3. Mode `TRANSLATE_DUB` — Dịch thuật & Lồng tiếng

| Mã | Chức năng |
| --- | --- |
| FR-T1 | Upload video (≤ 2GB) resumable (chunk 8MB, kiểu TUS), xác thực định dạng & kích thước |
| FR-T2 | Demux FFmpeg: tách audio/video; chuẩn hoá âm lượng LUFS cho STT |
| FR-T3 | STT: transcript + timestamps từ audio đã chuẩn hoá (ASR Whisper + overlap stitching 15s) |
| FR-T4 | Dịch LLM gom theo context window, routing 1 trong 13 StylePreset (văn phong/xưng hô/slang), chiến lược 3 vòng (TransFlow) |
| FR-T5 | Sinh phụ đề đích (SRT/ASS) neo vị trí đáy màn hình (`\an2`) |
| FR-T6 | (Tuỳ chọn) TTS lồng tiếng + Forced Alignment khớp slot thời gian gốc (`TEMPO_MAX = 1.35`, pause-expansion) |
| FR-T7 | Subtitle Masking: Tạo vùng che hardsub tự động (Vision) hoặc vẽ thủ công trên Canvas; quản lý lifecycle mask `DRAFT`, `APPROVED`, `DISABLED` (APPROVED bất biến khi render) |
| FR-T8 | Burn-in mask `APPROVED` + Burn-in phụ đề mới + Dynamic Sidechain Ducking (-12dB khi có giọng nói) + mux MP4 (NVENC/x264) |
| FR-T9 | Tiến trình real-time qua SSE; theo dõi tiến độ từng stage |
| FR-T10 | Chỉnh sửa trực tiếp transcript (`PATCH /segments/:id/translation`), hỗ trợ Redub không cần chạy lại STT, optimistic concurrency qua `transcript_version` |

### 3.4. Mode `SCRIPT_TO_VIDEO` — Tạo video từ kịch bản

| Mã | Chức năng |
| --- | --- |
| FR-SC1 | Upload tệp kịch bản (`.txt`, ≤ 5MB) hoặc nhập văn bản trực tiếp qua giao diện |
| FR-SC2 | Chuẩn hóa, làm sạch văn bản và kiểm tra toàn vẹn băm SHA-256 (`scriptIngest`) |
| FR-SC3 | Phân đoạn kịch bản (`scriptAnalyze`): Dùng LLM tách thành các `script_segments` gồm lời đọc (narration) và gợi ý thị giác (visual prompt), có fallback quy tắc ngữ pháp |
| FR-SC4 | Review Gate (`script_review_required = 1`): Tạm dừng sau phân tích để người dùng kiểm tra và chỉnh sửa nội dung/phân đoạn trước khi sinh media |
| FR-SC5 | Sinh giọng đọc AI (`scriptTts`): Tạo audio thuyết minh cho từng phân đoạn theo giọng đã chọn |
| FR-SC6 | Tạo hình ảnh slide minh họa (`scriptImage`): Tự động tạo ảnh slide minh họa khớp với nội dung từng đoạn |
| FR-SC7 | Căn chỉnh thời lượng (`scriptAlign`) & sinh phụ đề (`scriptSubtitle`) |
| FR-SC8 | Kết xuất video hoàn chỉnh (`scriptRender`): Ghép ảnh, audio thuyết minh, nhạc nền và phụ đề ASS |

### 3.5. Quản trị & quan sát

- Dashboard: Widget video đã sinh, trạng thái queue, storage, provider status, quota usage.
- Trang: Projects, Project Detail (timeline + video player + transcript editor), Queue, Outputs, Settings, Provider Settings, ApiKeys, Logs, Analytics, Admin.
- Xem log cuộc gọi AI (ProviderLog) và lỗi chi tiết.

### 3.6. Kiểm soát vòng đời Job & Dự án

| Mã | Chức năng |
| --- | --- |
| FR-J1 | User có thể **huỷ (cancel)** một project đang chạy pipeline ở bất kỳ stage nào qua `POST /projects/:id/cancel` (Graceful cancellation qua `AbortController`, đặt status `cancelled`) |
| FR-J2 | User có thể **chạy lại (regenerate)** pipeline qua `POST /projects/:id/regenerate` (tự động tiếp tục từ stage lỗi earliest hoặc chọn chạy lại từ stage cụ thể `fromStage`) |
| FR-J3 | Hệ thống gửi **thông báo hoàn thành/thất bại** qua email (Nodemailer SMTP via `notifyQueue`) khi pipeline kết thúc |
| FR-J4 | Hệ thống tự động **dọn dẹp file trung gian & dữ liệu hết hạn** qua outbox tasks (`project_cleanup_tasks` và `cleanupWorker`) |
| FR-J5 | Tự phục hồi sau khởi động lại: Hệ thống quét các project bị kẹt `running` do restart máy chủ và tự động đưa về `queued` để tiếp tục từ stage dở dang (`recoverStaleProjects`) |

---

## 4. Yêu cầu phi chức năng (Non-functional Requirements)

| Mã | Yêu cầu |
| --- | --- |
| NFR-1 | **Maintainable** — Clean Architecture, module tách biệt rõ ràng, không code trùng lặp |
| NFR-2 | **Secure** — JWT access + HttpOnly refresh cookie, mã hoá API key bằng AES-256-GCM, RBAC, an toàn đường dẫn lưu trữ chống traversal |
| NFR-3 | **Extensible** — Provider Pattern; thêm provider AI hoặc mode mới không cần sửa logic cốt lõi |
| NFR-4 | **Observable** — Ghi log có cấu trúc + ProviderLog chi tiết từng cuộc gọi + số liệu hàng đợi |
| NFR-5 | **Testable** — Unit/integration test bằng `node:test`, mock provider độc lập không tốn quota thật |
| NFR-6 | **Scalable** — BullMQ worker điều phối qua Redis, abstraction xử lý media |
| NFR-7 | **Resilient** — Retry tự động với backoff cho transient errors, phục hồi phiên upload, phục hồi sau crash |
| NFR-8 | **Performant** — Resumable upload chunk 8MB; STT xử lý chunk song song; render tăng tốc phần cứng NVENC |
| NFR-9 | **Real-time UX** — Tiến trình job cập nhật thời gian thực qua Server-Sent Events (SSE) kèm ticket bảo mật |
| NFR-10 | **Kiểm soát tài nguyên** — Giới hạn tối đa 2 project `running` đồng thời / user (`MAX_CONCURRENT_PROJECTS_PER_USER`), hàng đợi vượt ngưỡng tự động xếp `queued` |
| NFR-11 | **Tuân thủ bản quyền** — Yêu cầu user xác nhận quyền sử dụng nội dung (`copyrightAcknowledged = true`) trước khi bắt đầu xử lý |
| NFR-12 | **Chịu được giới hạn API miễn phí** — Rate limiter (Token Bucket + Sliding Window), QuotaGuard phát hiện cạn quota, cache kết quả gọi AI (`provider_cache`) |

---

## 5. Trách nhiệm nội dung & bản quyền (Content Liability)

- Hệ thống **không kiểm duyệt tự động** bản quyền của nội dung nguồn do người dùng tải lên.
- Khi tạo dự án, người dùng bắt buộc phải **tick chọn xác nhận** đã có quyền sử dụng/sở hữu nội dung (lưu `copyright_acknowledged = 1` kèm timestamp).
- Thành phẩm video do AI sản xuất hoàn toàn thuộc trách nhiệm pháp lý của người dùng khi công khai hoặc phân phối.
- Chức năng liên kết và xuất bản lên YouTube yêu cầu xác nhận lại trước khi publish.

---

## 6. Định nghĩa thuật ngữ

- **Scene:** Đoạn phim liên tục giữa hai điểm cắt cảnh (shot detection cut).
- **ScriptSegment:** Phân đoạn kịch bản (lời thoại + mô tả thị giác), có thời lượng dự kiến.
- **TimelineClip:** Bản ghi phân đoạn video đã được căn giờ (in/out, tốc độ, transition) trên timeline xuất.
- **Align:** Thuật toán đồng bộ lời bình review với các cảnh phim được chọn (trong mode `SUMMARY`).
- **TranscriptSegment:** Đoạn thoại do STT nhận dạng, gồm start/end timestamp, nội dung gốc, bản dịch và nhãn người nói.
- **Forced Alignment:** Thuật toán ép khớp thời lượng giọng TTS vào slot thời gian của câu gốc (trong mode `TRANSLATE_DUB`).
- **Subtitle Masking:** Tạo vùng che mờ (blur) hoặc che màu (solid) đè lên hardsub gốc của video.
- **StylePreset:** 1 trong 13 phong cách biên dịch (hệ thống system prompt định hình văn phong, xưng hô, tiếng lóng).
- **Review Gate:** Điểm dừng có chủ đích trong pipeline kịch bản để người dùng duyệt và tinh chỉnh trước khi tiến hành sinh media tốn tài nguyên.
