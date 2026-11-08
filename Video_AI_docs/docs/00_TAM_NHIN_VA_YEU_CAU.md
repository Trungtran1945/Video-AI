# 00 — Tầm nhìn và Yêu cầu

## 1. Tầm nhìn (Project Vision)

**AI Shorts Factory (Video-AI)** là nền tảng SaaS giúp người dùng biến nội dung dài, video ngoại ngữ hoặc văn bản kịch bản thô thành video hoàn chỉnh, được AI sản xuất **tự động**, mà không cần kỹ năng dựng video timeline phức tạp.

Hệ thống phục vụ các nhóm use-case chính:

- **Người sáng tạo truyền thông đa phương tiện (AI Media Composer):** Có kho ảnh tư liệu, ảnh slide, nhạc nền BGM, muốn xây dựng video quảng cáo/thuyết minh chuyên nghiệp với kịch bản linh hoạt, quét chữ OCR từ ảnh, dịch thuật tự động, lồng tiếng AI, tự động dàn dựng đa rãnh và tuỳ biến chi tiết trên Timeline Studio 5 rãnh độc lập (`background`, `image`, `voiceover`, `music`, `text`).
- **Người làm nội dung dịch thuật & lồng tiếng (Translate & Dub):** Có 1 video nước ngoài (anime, vlog, phim ngắn... ≤ 2GB, kèm hardsub), muốn dịch phụ đề tiếng Việt tự nhiên theo 1 trong **13 phong cách dịch**, tuỳ chọn lồng tiếng AI ép khớp timestamp gốc (Forced Alignment TTS), tự động che hardsub gốc và giữ nguyên hình ảnh gốc.
- **Người sáng tạo nội dung từ kịch bản (Script to Video):** Có kịch bản văn bản (upload tệp `.txt` hoặc paste nội dung), muốn tự động chuyển hóa thành video hoàn chỉnh có thuyết minh AI, hình ảnh slide minh hoạ đồng bộ, phụ đề động và kết xuất MP4 sẵn sàng xuất bản.
- **Người làm nội dung review phim / tóm tắt (Movie Summary - Legacy):** Duy trì khả năng truy cập và xem lại các dự án review phim dài 20–30 phút đã tạo từ trước.

### Mục tiêu chất lượng (Success Metrics)

- Tỷ lệ pipeline chạy thành công end-to-end ≥ 95%.
- Ghép đa lớp hình ảnh (Background + Slideshow) và dynamic sidechain ducking (-12dB khi có giọng nói) chuẩn xác trong `MEDIA_COMPOSER`.
- Forced alignment dub trong mode `TRANSLATE_DUB` lệch slot gốc < 5% mỗi câu, không chồng tiếng, không sóc chuột (`TEMPO_MAX = 1.35`).
- Đồng bộ giọng đọc ↔ cảnh trong mode `SUMMARY` sai lệch < 1 giây mỗi đoạn.
- Thời gian sản xuất video tự động nhanh chóng trên cấu hình đề xuất.
- Thêm 1 provider AI mới không yêu cầu sửa business logic core (Provider Pattern).
- Triển khai production tinh gọn chỉ bằng `docker compose up`.

---

## 2. Phạm vi (Scope)

### 2.1. Trong phạm vi

- Ba mode sản xuất video tạo mới chính thức: `MEDIA_COMPOSER` (Dựng video đa phương tiện AI), `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng) và `SCRIPT_TO_VIDEO` (Tạo video từ kịch bản); kèm chế độ đọc `SUMMARY` (Review phim legacy).
- Khởi tạo dự án trống (không bắt buộc tải video gốc) đối với `MEDIA_COMPOSER`, tùy chọn tỷ lệ khung hình (16:9, 9:16, 1:1), độ phân giải (1080p, 720p), FPS (30, 60) và màu nền.
- Upload phim / video cần Việt hoá ≤ 2GB (TRANSLATE_DUB) qua dashboard, dùng **resumable upload chuẩn TUS-like** (chunk 8MB cố định, limit 2GB) chống rớt mạng. File vượt quá 2GB bị từ chối ngay từ API, không enqueue để tránh lãng phí tài nguyên.
- Upload tệp kịch bản (`.txt`) cho chế độ `SCRIPT_TO_VIDEO`, kiểm tra toàn vẹn mã băm SHA-256 (`script_hash`) và quản lý phiên bản kịch bản (`script_version`).
- Pipeline AI tự động:
  - **`MEDIA_COMPOSER` (3 stages)**: `composer.ingest → composer.prepare → composer.render`. Kiểm tra timeline & tự động xếp dàn đều ảnh khớp voiceover (`composerIngest`), scale/pad ảnh theo aspect ratio và sinh phụ đề ASS UTF-8 Unicode-safe có hỗ trợ font family (`composerPrepare`), ghép 2 lớp visual (Background + Slideshow motion), BGM loop (`aloop`), dynamic sidechain ducking (-12dB) và burn-in phụ đề ASS (`composerRender`).
  - **`TRANSLATE_DUB` (7 stages)**: `dub.ingest → dub.stt → dub.merge → dub.translate → dub.mask → dub.ttsAlign → dub.render`. STT-only extraction (Whisper ASR + 15s overlap stitching), 13 phong cách dịch LLM (TransFlow 3 vòng), TTS + Forced Alignment, Subtitle Masking tự động hoặc chỉnh tay trên Canvas (với trạng thái DRAFT / APPROVED / DISABLED, APPROVED là bất biến), Burn-in phụ đề ASS ở đáy khung hình (`\an2`), Dynamic sidechain ducking (-12dB).
  - **`SCRIPT_TO_VIDEO` (7 stages)**: `script.ingest → script.analyze → script.tts → script.image → script.align → script.subtitle → script.render`. Hỗ trợ review gate (`script_review_required = 1`) sau phân đoạn để user duyệt kịch bản trước khi render.
  - **`SUMMARY` (8 stages - Legacy)**: `summary.transcribe → summary.sceneDetect → summary.analyze → summary.script → summary.align → summary.tts → summary.subtitle → summary.render`.
- Dashboard theo dõi tiến trình **real-time qua SSE** (`GET /projects/:id/events` dùng vé tạm `sse-ticket`), xem kết quả, quản lý provider/API key.
- Studio đa năng: Multi-track Timeline Editor 5 rãnh (`background`, `image`, `voiceover`, `music`, `text`), hỗ trợ kéo thả, co kéo 2 đầu độc lập (dual-handle trim), chỉnh âm lượng/mute/lock từng rãnh.
- Chế độ xem trước kép (Dual-mode Preview): Realtime Canvas preview (đồng bộ voiceover + BGM ducking) khi đang dựng và HTML5 Video MP4 khi đã render thành phẩm.
- Trình chỉnh sửa phụ đề song ngữ (Bilingual Transcript Editor) với optimistic concurrency (`transcript_version`), audio preview và redubbing.
- Trình chỉnh vùng che chữ (MaskEditor) trực tiếp trên trình duyệt bằng HTML5 Canvas.
- Xuất video hoàn chỉnh và hỗ trợ tích hợp kết nối YouTube OAuth.

### 2.2. Ngoài phạm vi (MVP)

- Không hỗ trợ live-streaming trực tiếp.
- Không có hệ thống thanh toán / ví điểm thưởng — mọi tính năng mở cho user đã đăng nhập.
- Database: Hiện tại sử dụng `sql.js` (WebAssembly SQLite 30 bảng với file lưu trữ `backend/data.db` và single-writer lock); PostgreSQL là hướng nâng cấp khi scale ngang.
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

### 3.5. Mode `MEDIA_COMPOSER` — AI Media Composer

| Mã | Chức năng |
| --- | --- |
| FR-MC1 | Khởi tạo dự án trống (không bắt buộc tải video gốc), cấu hình tỷ lệ khung hình (16:9, 9:16, 1:1), độ phân giải (1080p, 720p), FPS (30fps, 60fps) và màu nền mặc định |
| FR-MC2 | Tải lên đa tài nguyên (Images, Background, Voiceover, Music/BGM) qua endpoint `/assets` với lưu trữ an toàn tại `storage/projects/:id/assets/` |
| FR-MC3 | Thư viện tư liệu (Media Library) trực quan phân loại theo 5 tab: Hình ảnh, Nền, Giọng đọc, Nhạc nền, Chữ overlay |
| FR-MC4 | Thay đổi thứ tự ảnh (Reorder) trực tiếp trên giao diện bằng nút điều hướng Lên / Xuống và lưu trữ DB qua API `PUT /assets/reorder` |
| FR-MC5 | Quét chữ OCR từ hình ảnh tư liệu (Tesseract / Gemini OCR) với cơ chế lưu đệm 2 tầng (Asset cache & Provider cache) |
| FR-MC6 | Dịch thuật tự động nội dung chữ OCR sang tiếng Việt (Google Translate / LLM) với cơ chế lưu đệm 2 tầng |
| FR-MC7 | Tổng hợp giọng đọc thuyết minh AI (Edge-TTS, ElevenLabs, VoiceStudio, Google TTS, ZeroTTS) kèm tính năng nghe thử và tự động thêm vào thư viện |
| FR-MC8 | Tự động dàn dựng (Auto-Arrange): Tự động tính toán thời lượng tổng theo giọng đọc hoặc ảnh mặc định (4s), chia đều ảnh khớp giọng, ducking nhạc nền xuống 0.25, và tạo text overlay từ OCR |
| FR-MC9 | Đặt lại Timeline (Reset Timeline): Dọn sạch toàn bộ clip trên dòng thời gian kèm hộp thoại cảnh báo xác nhận `AlertDialog` |
| FR-MC10 | Multi-track Timeline Studio 5 rãnh độc lập (`background`, `image`, `voiceover`, `music`, `text`) với icon và màu nhận diện chuyên nghiệp |
| FR-MC11 | Co kéo thời lượng độc lập 2 đầu (Dual-handle trim) trên từng clip: Kéo handle trái để chỉnh start & duration, kéo handle phải để chỉnh duration |
| FR-MC12 | Bảng điều khiển Clip Inspector: Tùy biến thời gian bắt đầu, thời lượng, âm lượng, vị trí hiển thị (Trên / Giữa / Dưới), cỡ chữ, màu sắc, phông chữ (Arial, Roboto, Montserrat, Times New Roman), và nền văn bản |
| FR-MC13 | Chế độ xem trước kép (Dual Preview): Trình xem thời gian thực Canvas Preview đồng bộ âm thanh Voiceover + BGM ducking khi đang dựng; tự động chuyển sang HTML5 Video MP4 khi đã render thành phẩm |
| FR-MC14 | Chuẩn hóa tài nguyên (`composer.prepare`): Scale & pad ảnh theo tỷ lệ khung hình, chuẩn hóa audio 48kHz stereo, và trích xuất tệp phụ đề ASS UTF-8 Unicode-safe có hỗ trợ font family, size và color |
| FR-MC15 | Ghép đa lớp FFmpeg (`composer.render`): Kết hợp Background layer + Slideshow layer với motion zoom nhẹ (1.05x), lặp vô hạn BGM (`aloop`), dynamic sidechain ducking (-12dB khi có giọng nói) và nhúng phụ đề ASS |
| FR-MC16 | Kết xuất video MP4 Full HD (H.264/AAC), thăm dò thông số bằng ffprobe, sinh ảnh thumbnail và lưu vào bảng `outputs` |

### 3.6. Quản trị & quan sát

- Dashboard: Widget video đã sinh, trạng thái queue, storage, provider status, quota usage.
- Trang: Projects, Project Detail (timeline + video player + transcript editor), Queue, Outputs, Settings, Provider Settings, ApiKeys, Logs, Analytics, Admin.
- Xem log cuộc gọi AI (ProviderLog) và lỗi chi tiết.

### 3.7. Kiểm soát vòng đời Job & Dự án

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
