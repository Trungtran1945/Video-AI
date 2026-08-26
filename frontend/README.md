# Video AI — Frontend

Giao diện web cho hệ thống sản xuất video tự động: **Tóm tắt phim** (review phim dài thành video 20–30 phút) và **Dịch thuật & Lồng tiếng** (Việt hoá video nước ngoài có hardsub: dịch phụ đề theo 12 phong cách, tuỳ chọn lồng giọng AI).

Stack: React 18 + Vite, React Router, TanStack Query, Framer Motion, Tailwind CSS, shadcn/ui, axios.

## Kiến trúc

- Frontend chạy độc lập với backend. Toàn bộ dữ liệu qua REST API `/api/v1`.
- Vite dev server proxy `/api` → `http://localhost:3001` (backend Express).
- Xác thực JWT: `access_token` / `refresh_token` lưu localStorage, tự refresh khi gặp 401.
- File upload/storage: backend trả key dạng `uploads/...`, file được serve tại `/storage/<key>`.

## Yêu cầu

- Node.js 18+
- Backend đang chạy tại `http://localhost:3001` (xem thư mục `../backend`).

## Chạy local

1. Cài dependencies:

```bash
npm install
```

2. Chạy backend (terminal riêng):

```bash
cd ../backend
npm install
npm run dev
```

Backend mặc định lắng nghe cổng **3001** (tự tăng nếu bận). API root: `http://localhost:3001/api/v1`.

3. Chạy frontend:

```bash
npm run dev
```

Mở URL Vite in ra terminal (mặc định `http://localhost:5173`).

## Biến môi trường

File `.env` ở thư mục gốc frontend:

```bash
VITE_API_BASE=/api/v1
```

Chỉ đổi khi bạn muốn trỏ thẳng tới backend ở nơi khác (ví dụ `http://localhost:4000/api/v1`) thay vì đi qua proxy của Vite.

## Cấu trúc chính

```
src/
├── api/            # axios client + các endpoint (projects, upload, auth...)
├── components/     # Layout, ProtectedRoute, ui/ (shadcn)
├── hooks/          # useIsMobile, useSize
├── lib/            # AuthContext, constants, query-client
├── pages/          # Dashboard, Projects, CreateProject (wizard), ProjectDetail...
└── utils/
```

Trang tạo dự án (`/projects/new`) là wizard 2 mode:
- **SUMMARY** — Tóm tắt phim: upload phim → ngôn ngữ → độ dài 20–30 phút → phong cách/tone/spoiler → giọng đọc → Generate.
- **TRANSLATE_DUB** — Dịch thuật & Lồng tiếng: upload video resumable (≤2GB) → ngôn ngữ nguồn/đích → chọn 1 trong 12 phong cách dịch → bật/tắt lồng tiếng AI + chọn giọng → chỉnh vùng che hardsub trên Canvas (tuỳ chọn) → Generate, theo dõi tiến trình realtime bằng SSE.

> ⚠️ Code hiện tại vẫn đang triển khai mode cũ `STYLE_EDIT` (edit theo mẫu) — cần migrate sang
> `TRANSLATE_DUB` theo đặc tả mới tại `../AI-Shorts-Factory-Documentation-Starter/docs/04_THIET_KE_FRONTEND.md`.

## Scripts

| Lệnh | Mô tả |
| --- | --- |
| `npm run dev` | Dev server Vite |
| `npm run build` | Build production vào `dist/` |
| `npm run preview` | Xem thử bản build |
| `npm run lint` | ESLint |
| `npm run typecheck` | Kiểm tra kiểu (jsconfig) |

## Tài liệu thiết kế

Toàn bộ đặc tả nằm ở thư mục `../AI-Shorts-Factory-Documentation-Starter/docs/` (kiến trúc, database, pipeline, frontend, API).
