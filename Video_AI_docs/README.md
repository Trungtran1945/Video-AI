# AI Shorts Factory (Video-AI) — Tài liệu thiết kế hệ thống

> **AI Shorts Factory** là nền tảng SaaS tự động sản xuất video bằng AI.
> Hệ thống được thiết kế theo hướng **Clean Architecture**, **Provider Pattern** đa mô hình
> và **kiến trúc hàng đợi (BullMQ + Redis)** để đảm bảo mở rộng, bền vững, dễ bảo trì và không phụ thuộc
> vào một nhà cung cấp AI/Cloud duy nhất.

---

## 1. Tầm nhìn sản phẩm

Hệ thống cung cấp **ba chế độ sản xuất video tự động** (người dùng không cần tự dựng timeline thủ công):

| Mode | Mô tả | Đầu vào | Quy trình & Đầu ra |
| --- | --- | --- | --- |
| `SUMMARY` | **Review phim & Tóm tắt video** | 1 bộ phim / video dài **2–3 tiếng** | Video **review phim 20–30 phút** có giọng đọc thuyết minh AI, cảnh cắt từ phim gốc khớp chuẩn xác với lời bình qua thuật toán Align. |
| `TRANSLATE_DUB` | **Dịch thuật & Lồng tiếng** | 1 video nước ngoài ≤ 2GB, chọn 1 trong **13 phong cách dịch** | Video giữ nguyên nhịp hình ảnh gốc, **dịch phụ đề tiếng Việt** theo phong cách + **lồng tiếng AI ép khớp slot thời gian (Forced Alignment TTS)**, tự động che hardsub gốc (Masking). |
| `SCRIPT_TO_VIDEO` | **Tạo video từ kịch bản** | Kịch bản văn bản (upload file `.txt` / paste nội dung) | Video tự động phân đoạn kịch bản, sinh giọng lồng tiếng AI, tạo hình ảnh slide minh hoạ, căn chỉnh thời lượng và render thành phẩm hoàn chỉnh. |

Cả ba chế độ tuân thủ nguyên tắc: **user cấu hình đầu vào → AI thực thi pipeline đa tầng → user xem kết quả và tinh chỉnh**.

---

## 2. Cấu trúc tài liệu

| File | Nội dung |
| --- | --- |
| [`docs/00_TAM_NHIN_VA_YEU_CAU.md`](docs/00_TAM_NHIN_VA_YEU_CAU.md) | Tầm nhìn, phạm vi, yêu cầu chức năng & phi chức năng cho 3 chế độ |
| [`docs/01_KIEN_TRUC_TONG_THE.md`](docs/01_KIEN_TRUC_TONG_THE.md) | Kiến trúc tổng thể, layout thực tế `backend/` + `frontend/`, luồng 3 pipeline, Provider Pattern, Queue |
| [`docs/02_THIET_KE_CO_SO_DU_LIEU.md`](docs/02_THIET_KE_CO_SO_DU_LIEU.md) | Thiết kế cơ sở dữ liệu (`sql.js` SQLite 29 bảng), schema, quan hệ, snapshot & writer lock |
| [`docs/03_THIET_KE_BACKEND.md`](docs/03_THIET_KE_BACKEND.md) | Backend Express ESM: Clean Architecture, DI, services, auth, quota guard, recovery |
| [`docs/04_THIET_KE_FRONTEND.md`](docs/04_THIET_KE_FRONTEND.md) | Frontend React 18 + Vite 6: wizard 3 mode, timeline, bilingual transcript editor, mask canvas editor, SSE realtime |
| [`docs/05_THIET_KE_PIPELINE_CHI_TIET.md`](docs/05_THIET_KE_PIPELINE_CHI_TIET.md) | Chi tiết thuật toán từng stage của 3 pipeline: Align giọng ↔ cảnh, Forced Alignment TTS, 13 StylePreset, Masking, Script-to-Video |
| [`docs/06_API.md`](docs/06_API.md) | REST API v1, Resumable Upload (TUS-like 2GB), SSE progress (`sse-ticket`), schema request/response |
| [`docs/07_MODULE_FFMPEG.md`](docs/07_MODULE_FFMPEG.md) | Module media/ffmpeg: transcode, scene-detect, speed stretch, dynamic sidechain ducking, burn-in subtitle & mask |
| [`docs/08_TRIEN_KHAI_VA_VAN_HANH.md`](docs/08_TRIEN_KHAI_VA_VAN_HANH.md) | Triển khai Docker, docker-compose (Redis, API, Web Nginx), ZeroTTS sidecar, biến môi trường, bảo mật |
| [`docs/09_DONG_GOP.md`](docs/09_DONG_GOP.md) | Quy trình đóng góp, kiểm thử hồi quy (`node scripts/run-tests.mjs`), lint, typecheck |
| [`docs/10_TASKS.md`](docs/10_TASKS.md) | Lộ trình và trạng thái các tính năng đã hoàn thiện ([DONE]), đang phát triển |
| [`docs/11_RATE_LIMIT_VA_FREE_TIER.md`](docs/11_RATE_LIMIT_VA_FREE_TIER.md) | Chiến lược Rate Limiting (Token Bucket, Sliding Window), QuotaGuard, cache provider, chạy ổn định với API Free Tier |

---

## 3. Công nghệ thực tế (Current Stack)

- **Cấu trúc Repository:** Phẳng hai thành phần `backend/` và `frontend/` (JavaScript ESM).
- **Backend:** Node.js >=18 (ESM), Express 4, `sql.js` (WebAssembly SQLite với atomic snapshot memory-disk và file `backend/data.db`, single-writer lock `data.db.writer.lock`), BullMQ 5 + Redis 7, JWT auth (access token + HttpOnly refresh cookie), SSE event bus.
- **Frontend:** React 18, Vite 6, TailwindCSS, Radix UI / shadcn/ui, TanStack Query v5, Framer Motion, Lucide icons.
- **Media Engine:** FFmpeg & FFprobe (quản lý qua `backend/src/media/ffmpeg.js` và `mediaService.js`, có cơ chế serialize tiến trình trên Windows).
- **TTS Engine:** Hỗ trợ đa nhà cung cấp: Microsoft Edge-TTS, Google TTS, ElevenLabs, OpenAI TTS và ZeroTTS (Python local sidecar chạy qua `npm run dev`).
- **AI/Provider Pattern:** Quản lý tập trung qua `backend/src/providers/registry.js` và `callProvider.js` cho ASR (Whisper), LLM (Gemini, OpenAI), Vision (Gemini Vision), Translate (Google Translate, LLM direct), Image (SlideImage).

---

## 4. Nguyên tắc thiết kế cốt lõi

1. **Không phụ thuộc một nhà cung cấp duy nhất** — Toàn bộ AI được trừu tượng hóa qua Provider Pattern; có thể đổi hoặc failover provider mà không sửa business logic.
2. **Tự động hóa hoàn toàn kèm công cụ tinh chỉnh thủ công** — Mọi căn chỉnh đồng bộ (giọng ↔ hình ảnh) do thuật toán tự động xử lý, đồng thời cung cấp giao diện sửa transcript, vẽ vùng che hardsub (MaskEditor) và chạy lại theo từng stage (Regenerate).
3. **Độ quan sát cao (Observability)** — Mọi cuộc gọi AI đều ghi nhật ký vào bảng `provider_logs` (thời gian, model, tokens, chi phí, trạng thái).
4. **Bền vững & Chịu lỗi (Fault Tolerance)** — BullMQ retry với backoff; tự động phục hồi các project bị ngắt quãng do server restart; cơ chế QuotaGuard bảo vệ tài khoản API free tier.
5. **Đảm bảo tính toàn vẹn dữ liệu** — Optimistic concurrency qua `transcript_version` để phát hiện output cũ (`outputStale`); mask `APPROVED` bất biến khi render.
