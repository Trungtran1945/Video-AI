# AI Shorts Factory — Tài liệu thiết kế hệ thống

> **AI Shorts Factory** là nền tảng SaaS tự động sản xuất video bằng AI.
> Hệ thống được thiết kế theo hướng **monorepo**, **Clean Architecture**, **Provider Pattern**
> và **kiến trúc hàng đợi (BullMQ + Redis)** để đảm bảo mở rộng, dễ bảo trì và không phụ thuộc
> vào một nhà cung cấp AI/Cloud duy nhất.

---

## 1. Tầm nhìn sản phẩm

Hệ thống tập trung vào **hai hướng sản phẩm chính**, đều được AI sản xuất đầu ra video một cách
**tự động hoàn toàn** (người dùng không cần tự chỉnh sửa timeline):

| Mode | Mô tả | Đầu vào | Đầu ra |
| --- | --- | --- | --- |
| `SUMMARY` | **Review phim** | 1 bộ phim dài **2–3 tiếng** | Video **review phim 20–30 phút** có giọng đọc review, cảnh cắt từ phim gốc khớp với lời review |
| `TRANSLATE_DUB` | **Dịch thuật & Lồng tiếng** | 1 video nước ngoài có **phụ đề cứng (hardsub)** ≤ 2GB, chọn 1 trong **13 phong cách dịch** | Video giữ nguyên hình ảnh gốc, đã **dịch phụ đề tiếng Việt** đè lên vùng hardsub được che + **giọng lồng AI ép khớp timestamp** (tuỳ chọn) |

Cả hai hướng đều tuân thủ nguyên tắc: **user cấu hình → AI chạy pipeline → user xem kết quả**.

---

## 2. Cấu trúc tài liệu

| File | Nội dung |
| --- | --- |
| [`docs/00_TAM_NHIN_VA_YEU_CAU.md`](docs/00_TAM_NHIN_VA_YEU_CAU.md) | Tầm nhìn, phạm vi, yêu cầu chức năng & phi chức năng |
| [`docs/01_KIEN_TRUC_TONG_THE.md`](docs/01_KIEN_TRUC_TONG_THE.md) | Kiến trúc tổng thể, monorepo, luồng 2 pipeline, Provider Pattern, Queue |
| [`docs/02_THIET_KE_CO_SO_DU_LIEU.md`](docs/02_THIET_KE_CO_SO_DU_LIEU.md) | Thiết kế cơ sở dữ liệu (Prisma), ERD, quan hệ, migration |
| [`docs/03_THIET_KE_BACKEND.md`](docs/03_THIET_KE_BACKEND.md) | Backend: Clean Architecture, DI, services, auth, logging |
| [`docs/04_THIET_KE_FRONTEND.md`](docs/04_THIET_KE_FRONTEND.md) | Frontend: trang, wizard, components, hooks, state |
| [`docs/05_THIET_KE_PIPELINE_CHI_TIET.md`](docs/05_THIET_KE_PIPELINE_CHI_TIET.md) | Thuật toán Align (giọng khớp cảnh), OCR hardsub, Forced Alignment, 13 StylePreset, từng stage |
| [`docs/06_API.md`](docs/06_API.md) | REST API cho cả 2 mode, schema request/response |
| [`docs/07_MODULE_FFMPEG.md`](docs/07_MODULE_FFMPEG.md) | Gói media/ffmpeg: transcode, scene-detect, concat, conform, grade, subtitle |
| [`docs/08_TRIEN_KHAI_VA_VAN_HANH.md`](docs/08_TRIEN_KHAI_VA_VAN_HANH.md) | Docker, docker-compose, GitHub Actions, env, scaling |
| [`docs/09_DONG_GOP.md`](docs/09_DONG_GOP.md) | Quy trình đóng góp, lint/test, cấu trúc chuẩn |

---

## 3. Công nghệ mục tiêu (Target Stack)

- **Monorepo:** pnpm workspaces.
- **Backend:** Node.js 22+, TypeScript (strict), Express, Prisma (SQLite MVP → PostgreSQL), BullMQ + Redis, Zod, JWT, Swagger/OpenAPI, Pino.
- **Frontend:** React 19, Vite, TypeScript, TailwindCSS, shadcn/ui, TanStack Query, React Router, React Hook Form, Framer Motion.
- **Media:** FFmpeg (gói `packages/media` đóng gói mọi thao tác).
- **AI/Provider:** Provider Pattern cho ASR (+ diarization), TTS, OCR (hardsub), Vision/LLM,
  Video-gen (có thể mở rộng).

---

## 4. Nguyên tắc thiết kế

1. **Không phụ thuộc nhà cung cấp duy nhất** — mọi AI/Cloud qua interface (`AIProvider`, `AsrProvider`, `TtsProvider`, `VisionProvider`).
2. **Tự động hoàn toàn** — user không sửa tay; mọi đồng bộ (giọng ↔ cảnh) do thuật toán `Align` xử lý.
3. **Có thể quan sát** — mọi cuộc gọi AI đều ghi `ProviderLog` (provider, model, tokens, cost, duration, status).
4. **Bền vững & thử lại** — BullMQ retry với backoff; job idempotent theo `GenerationJob`.
5. **Sạch & mở rộng** — Clean Architecture + Dependency Injection; thêm provider/mode không sửa business logic.
