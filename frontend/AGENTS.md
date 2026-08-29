# AGENTS.md

## Project Context

Frontend React + Vite của hệ thống Video AI (tóm tắt phim & dịch thuật + lồng tiếng video nước ngoài có hardsub).
Giao tiếp với backend Express riêng tại thư mục `../backend` qua REST `/api/v1` (Vite proxy → `http://localhost:3001`).
Không dùng bất kỳ dịch vụ/BaaS bên ngoài nào — mọi dữ liệu đều qua backend tự host.

> ⚠️ **Đang trong giai đoạn migrate mode**: đặc tả mục tiêu là `TRANSLATE_DUB`
> (dịch phụ đề 13 phong cách + lồng tiếng AI tuỳ chọn) nhưng code hiện tại vẫn còn mode cũ
> `STYLE_EDIT`/StyleProfile. Khi đụng tới wizard/API contract, ưu tiên theo đặc tả mới trong
> `../AI-Shorts-Factory-Documentation-Starter/docs/` và xoá dần code cũ.

## Key Files

- `src/api/client.js`: axios client gốc (baseURL `VITE_API_BASE`, đính JWT, tự refresh khi 401).
- `src/api/*.js`: các module endpoint (projects, upload, auth, outputs, extra).
- `src/lib/AuthContext.jsx`: trạng thái đăng nhập (localStorage access/refresh token).
- `src/lib/constants.jsx`: nhãn trạng thái, stage pipeline, ngôn ngữ/phong cách dịch (13 preset)/giọng đọc.
- `src/pages/CreateProject.jsx`: wizard tạo dự án 2 mode (SUMMARY / TRANSLATE_DUB) — đặc tả tại `../AI-Shorts-Factory-Documentation-Starter/docs/04_THIET_KE_FRONTEND.md` mục 4.
- `src/pages/ProjectDetail.jsx`: tiến trình pipeline (SSE realtime, fallback polling jobs), transcript song ngữ + SubRegionEditor Canvas (TRANSLATE_DUB), timeline preview (SUMMARY), output.
- `vite.config.js`: alias `@` → `src/`, proxy `/api` → `http://localhost:3001`.

## API Contract

- Tạo dự án: `POST /api/v1/projects` với `{mode: 'SUMMARY'|'TRANSLATE_DUB', title, ...}`:
  - SUMMARY: `{title, language, style, targetDurationSec, sourceVideoKey?, params?}`.
  - TRANSLATE_DUB: `{sourceLanguage?, targetLanguage, stylePreset, enableDubbing, voiceId?, maskMethod: 'blur'|'fill'|'inpaint', sourceVideoKey}` — backend tự chạy pipeline sau khi tạo (enqueue dub.stt ‖ dub.ocr song song).
- Upload file lớn (video ≤2GB): resumable kiểu TUS — `POST /uploads/init` → `PUT /uploads/:id/chunk?offset=N` (chunk 5–10MB, resume bằng `HEAD`) → `POST /uploads/:id/complete` → `{storageKey}`. Endpoint multipart cũ `POST /upload` vẫn dùng cho file nhỏ.
- Danh mục phong cách dịch: `GET /style-presets` → 13 preset (slug, name, description).
- Vùng che hardsub: `GET|PUT /projects/:id/mask-regions` (region user khoanh trên Canvas có `source='MANUAL'`).
- Tiến trình: SSE `GET /projects/:id/events` (`{stage, status, percent}` từng job); fallback poll `GET /projects/:id/jobs`. TRANSLATE_DUB trả thêm `transcript[]`, `ocrRegions[]`; SUMMARY trả `timeline[]`, `scenes[]`.
- Regenerate: `POST /api/v1/projects/:id/regenerate`.
- File output/storage: URL dạng `/storage/<storage_key>`.

## Working Notes

- Chạy local: backend `npm run dev` trong `../backend` trước, rồi `npm run dev` ở đây.
- Không thêm SDK/BaaS mới; chỉ gọi REST qua `src/api/client.js`.
- Giữ phong cách UI hiện tại: dark theme (#0F1117 nền), thẻ bo góc, accent xanh dương, framer-motion cho transition.
- Trước khi hoàn thành thay đổi code, chạy `npm run lint` và `npm run build` để kiểm chứng.
