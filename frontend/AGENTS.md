# AGENTS.md

## Project Context

Frontend React + Vite của hệ thống Video AI (tóm tắt phim & edit video ngắn theo mẫu).
Giao tiếp với backend Express riêng tại thư mục `../backend` qua REST `/api/v1` (Vite proxy → `http://localhost:3001`).
Không dùng bất kỳ dịch vụ/BaaS bên ngoài nào — mọi dữ liệu đều qua backend tự host.

## Key Files

- `src/api/client.js`: axios client gốc (baseURL `VITE_API_BASE`, đính JWT, tự refresh khi 401).
- `src/api/*.js`: các module endpoint (projects, upload, auth, outputs, extra).
- `src/lib/AuthContext.jsx`: trạng thái đăng nhập (localStorage access/refresh token).
- `src/lib/constants.jsx`: nhãn trạng thái, stage pipeline, ngôn ngữ/phong cách/giọng đọc.
- `src/pages/CreateProject.jsx`: wizard tạo dự án 2 mode (SUMMARY / STYLE_EDIT) — đặc tả tại `../AI-Shorts-Factory-Documentation-Starter/docs/04_THIET_KE_FRONTEND.md` mục 4.
- `src/pages/ProjectDetail.jsx`: tiến trình pipeline (polling jobs), timeline preview, output.
- `vite.config.js`: alias `@` → `src/`, proxy `/api` → `http://localhost:3001`.

## API Contract

- Tạo dự án: `POST /api/v1/projects` với `{mode: 'SUMMARY'|'STYLE_EDIT', title, language, style, targetDurationSec, aspectRatio?, sourceVideoKey?, templateVideoKey?, assets?: [{storageKey, kind}], params?}` — backend tự chạy pipeline sau khi tạo.
- Upload file: `POST /api/v1/upload` (multipart `file`) → `{key, url, filename, size}`.
- Tiến trình: poll `GET /api/v1/projects/:id` (có `status`, `progress`, `jobs[]`, `timeline[]`, `scenes[]`/`assets[]`, `output`) hoặc `GET /api/v1/projects/:id/jobs`.
- Regenerate: `POST /api/v1/projects/:id/regenerate`.
- File output/storage: URL dạng `/storage/<storage_key>`.

## Working Notes

- Chạy local: backend `npm run dev` trong `../backend` trước, rồi `npm run dev` ở đây.
- Không thêm SDK/BaaS mới; chỉ gọi REST qua `src/api/client.js`.
- Giữ phong cách UI hiện tại: dark theme (#0F1117 nền), thẻ bo góc, accent xanh dương, framer-motion cho transition.
- Trước khi hoàn thành thay đổi code, chạy `npm run lint` và `npm run build` để kiểm chứng.
