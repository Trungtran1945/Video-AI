# Video AI — Frontend

Giao diện web cho hệ thống sản xuất video tự động: **Tóm tắt phim** (review phim dài thành video 20–30 phút) và **Edit theo mẫu** (video ngắn 30s–1phút theo phong cách video mẫu).

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
- **STYLE_EDIT** — Edit theo mẫu: assets + video mẫu → độ dài 30s–1phút + tỷ lệ khung → phong cách → Generate.

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
