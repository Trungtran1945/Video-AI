# AI Shorts Factory (Video-AI) — Tài liệu thiết kế hệ thống

> **AI Shorts Factory** là nền tảng SaaS tự động sản xuất video bằng AI.
> Hệ thống được thiết kế theo hướng **Clean Architecture**, **Provider Pattern** đa mô hình
> và **kiến trúc hàng đợi (BullMQ + Redis)** để đảm bảo mở rộng, bền vững, dễ bảo trì và không phụ thuộc
> vào một nhà cung cấp AI/Cloud duy nhất.

---

## 1. Tầm nhìn sản phẩm

Hệ thống cung cấp **các chế độ sản xuất video tự động bằng AI** kết hợp công cụ Studio trực quan:

| Mode | Loại | Mô tả | Đầu vào | Quy trình & Đầu ra |
| --- | --- | --- | --- | --- |
| `MEDIA_COMPOSER` | **Flagship (Mới)** | **AI Media Composer** — Dựng video từ kho ảnh, kịch bản & giọng đọc AI | Kho ảnh slide, ảnh/video nền, nhạc nền BGM, nội dung kịch bản | Timeline 5 rãnh độc lập (`background`, `image`, `voiceover`, `music`, `text`), quét chữ OCR & dịch thuật 2 tầng có cache, lồng tiếng AI, tự động dàn dựng (Auto-Arrange), ghép đa lớp FFmpeg, audio ducking -12dB và phụ đề ASS UTF-8. |
| `TRANSLATE_DUB` | **Chính thức** | **Dịch thuật & Lồng tiếng** | 1 video nước ngoài ≤ 2GB, chọn 1 trong **13 phong cách dịch** | Video giữ nguyên nhịp hình ảnh gốc, **dịch phụ đề tiếng Việt** theo phong cách + **lồng tiếng AI ép khớp slot thời gian (Forced Alignment TTS)**, tự động che hardsub gốc (Masking). |
| `SCRIPT_TO_VIDEO` | **Chính thức** | **Tạo video từ kịch bản** | Kịch bản văn bản (upload file `.txt` / paste nội dung) | Video tự động phân đoạn kịch bản, sinh giọng lồng tiếng AI, tạo hình ảnh slide minh hoạ, căn chỉnh thời lượng và render thành phẩm hoàn chỉnh. |
| `SUMMARY` | **Legacy (Read-only)** | **Review phim & Tóm tắt video** | 1 bộ phim / video dài 2–3 tiếng (dự án cũ) | Duy trì khả năng xem lại các dự án cũ đã tạo. Video review phim có giọng đọc thuyết minh AI, cảnh cắt từ phim gốc khớp lời bình qua thuật toán Align. |

Nguyên tắc thiết kế: **User cấu hình đầu vào → AI thực thi pipeline đa tầng hoặc tự động xếp timeline → User xem trước thời gian thực (Dual Preview) và tinh chỉnh linh hoạt**.

---

## 2. Cấu trúc tài liệu

| File | Nội dung |
| --- | --- |
| [`docs/00_TAM_NHIN_VA_YEU_CAU.md`](docs/00_TAM_NHIN_VA_YEU_CAU.md) | Tầm nhìn, phạm vi, yêu cầu chức năng & phi chức năng cho 4 chế độ (FR-MC1 đến FR-MC16 cho Composer) |
| [`docs/01_KIEN_TRUC_TONG_THE.md`](docs/01_KIEN_TRUC_TONG_THE.md) | Kiến trúc tổng thể, layout thực tế `backend/` + `frontend/`, luồng 4 pipeline, Provider Pattern, Queue |
| [`docs/02_THIET_KE_CO_SO_DU_LIEU.md`](docs/02_THIET_KE_CO_SO_DU_LIEU.md) | Thiết kế cơ sở dữ liệu (`sql.js` SQLite 30 bảng), schema `timeline_tracks`, quan hệ, snapshot & writer lock |
| [`docs/03_THIET_KE_BACKEND.md`](docs/03_THIET_KE_BACKEND.md) | Backend Express ESM: Clean Architecture, `composerService.js`, `composerAssets.js`, auth, quota guard |
| [`docs/04_THIET_KE_FRONTEND.md`](docs/04_THIET_KE_FRONTEND.md) | Frontend React 18 + Vite 6: Media Composer Studio 4 pane, timeline 5 rãnh, dual preview, dual trim |
| [`docs/05_THIET_KE_PIPELINE_CHI_TIET.md`](docs/05_THIET_KE_PIPELINE_CHI_TIET.md) | Chi tiết thuật toán từng stage của các pipeline: Composer (ingest, prepare, render), Dubbing, Summary, Script-to-Video |
| [`docs/06_API.md`](docs/06_API.md) | REST API v1, Resumable Upload (2GB), SSE progress, 8 API endpoints của Composer (/assets, /timeline, /auto-arrange) |
| [`docs/07_MODULE_FFMPEG.md`](docs/07_MODULE_FFMPEG.md) | Module media/ffmpeg: transcode, multi-layer visual composition, dynamic sidechain ducking (-12dB), aloop, ASS burn-in |
| [`docs/08_TRIEN_KHAI_VA_VAN_HANH.md`](docs/08_TRIEN_KHAI_VA_VAN_HANH.md) | Triển khai Docker, docker-compose, volume storage projects/:id/assets, ZeroTTS sidecar, bảo mật |
| [`docs/09_DONG_GOP.md`](docs/09_DONG_GOP.md) | Quy trình đóng góp, kiểm thử hồi quy 176 test files (`npm test`), Playwright UI test, lint, typecheck |
| [`docs/10_TASKS.md`](docs/10_TASKS.md) | Lộ trình và trạng thái các tính năng đã hoàn thiện ([DONE]), bao gồm Giai đoạn 5 (AI Media Composer) |
| [`docs/11_RATE_LIMIT_VA_FREE_TIER.md`](docs/11_RATE_LIMIT_VA_FREE_TIER.md) | Chiến lược Rate Limiting, 2-tier cache cho OCR & Dịch thuật của Media Composer, chạy ổn định với API Free Tier |

---

## 3. Công nghệ thực tế (Current Stack)

- **Cấu trúc Repository:** Phẳng hai thành phần `backend/` và `frontend/` (JavaScript ESM).
- **Backend:** Node.js >=18 (ESM), Express 4, `sql.js` (WebAssembly SQLite 30 bảng với atomic snapshot memory-disk và file `backend/data.db`, single-writer lock `data.db.writer.lock`), BullMQ 5 + Redis 7, JWT auth (access token + HttpOnly refresh cookie), SSE event bus.
- **Frontend:** React 18, Vite 6, TailwindCSS, Radix UI / shadcn/ui, TanStack Query v5, Framer Motion, Lucide icons, Zustand (quản lý timeline state).
- **Media Engine:** FFmpeg & FFprobe (quản lý qua `backend/src/media/ffmpeg.js` và `mediaService.js`, hỗ trợ multi-layer visual composition và dynamic sidechain ducking).
- **TTS Engine:** Hỗ trợ đa nhà cung cấp: Microsoft Edge-TTS, Google TTS, ElevenLabs, OpenAI TTS và ZeroTTS (Python local sidecar chạy qua `npm run dev`).
- **AI/Provider Pattern:** Quản lý tập trung qua `backend/src/providers/registry.js` và `callProvider.js` cho ASR (Whisper), LLM (Gemini, OpenAI), Vision (Gemini Vision), Translate (Google Translate, LLM direct), Image (SlideImage), OCR (Tesseract / Gemini OCR).

---

## 4. Nguyên tắc thiết kế cốt lõi

1. **Không phụ thuộc một nhà cung cấp duy nhất** — Toàn bộ AI được trừu tượng hóa qua Provider Pattern; có thể đổi hoặc failover provider mà không sửa business logic.
2. **Tự động hóa hoàn toàn kèm công cụ tinh chỉnh thủ công** — Mọi căn chỉnh đồng bộ (giọng ↔ hình ảnh) do thuật toán tự động xử lý, đồng thời cung cấp giao diện sửa transcript, vẽ vùng che hardsub (MaskEditor) và chạy lại theo từng stage (Regenerate).
3. **Độ quan sát cao (Observability)** — Mọi cuộc gọi AI đều ghi nhật ký vào bảng `provider_logs` (thời gian, model, tokens, chi phí, trạng thái).
4. **Bền vững & Chịu lỗi (Fault Tolerance)** — BullMQ retry với backoff; tự động phục hồi các project bị ngắt quãng do server restart; cơ chế QuotaGuard bảo vệ tài khoản API free tier.
5. **Đảm bảo tính toàn vẹn dữ liệu** — Optimistic concurrency qua `transcript_version` để phát hiện output cũ (`outputStale`); mask `APPROVED` bất biến khi render.
