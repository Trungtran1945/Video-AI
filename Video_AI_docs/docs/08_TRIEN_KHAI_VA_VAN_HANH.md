# 08 — Triển khai và Vận hành

Hệ thống được thiết kế để triển khai production tinh gọn bằng **Docker** + **docker-compose**, và CI qua **GitHub Actions**.

---

## 1. Môi trường Thực tế (Current Architecture)

- **Ngôn ngữ & Runtime**: JavaScript (ES modules) trên Node.js 22 LTS (không dùng TypeScript/dist).
- **Quy trình chạy**:
  - Local Dev: Khởi động backend (`cd backend && npm run dev` chạy `scripts/dev.mjs`, tự động khởi tạo sidecar ZeroTTS Python nếu cấu hình bật), sau đó khởi động frontend (`cd frontend && npm run dev`).
  - Production: Backend chạy bằng lệnh `node server.js` (hoặc `npm start`). Tuyệt đối không tự động spawn tiến trình Python trong production.
- **Cơ sở dữ liệu**: `sql.js` (SQLite in-memory) lưu tệp tại `/app/data/data.db` (mount qua volume Docker `db_data`). Yêu cầu biến môi trường `INSTANCE_MODE=single` để bảo toàn nguyên tắc duy nhất một tiến trình sở hữu quyền ghi.
- **Hàng đợi & Worker**: Redis 7 và BullMQ. Tất cả worker (drain, notify, cleanup, youtube) chạy in-process bên trong tiến trình API chính; profile `scale` trong Compose được vô hiệu hóa để bảo vệ tính toàn vẹn của sql.js.

---

## 2. Docker & Dockerfile

Hệ thống build thành 2 image độc lập:

### 2.1. `docker/api.Dockerfile` → Image `asf-api`
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ ./backend/

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/package.json ./
COPY --from=build /app/backend/server.js ./
COPY --from=build /app/backend/src ./src
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server.js"]
```

### 2.2. `docker/web.Dockerfile` → Image `asf-web`
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### 2.3. Topology Same-Origin qua Nginx
- Trình duyệt chỉ gọi một origin duy nhất: `http://localhost/` (Nginx port 80).
- Nginx phục vụ tĩnh toàn bộ mã build Vite và reverse proxy các request `/api` sang container `api:3001`.
- Cookie `refresh_token` (`SameSite=Lax`) luôn là first-party, đảm bảo bảo mật và chống tấn công CSRF.
- Đường dẫn `/storage` được API lọc và phục vụ an toàn (`createSafeMediaStatic`).

---

## 3. Cấu hình Docker Compose (`docker-compose.yml`)

Hệ thống bao gồm 3 service phối hợp:
1. `redis`: Image `redis:7-alpine`, chạy trên port nội bộ 6379, lưu trữ bền vững với `appendonly yes`.
2. `api`: Backend Node.js Express, kết nối tới Redis và mount volume `db_data`, `storage_data`.
3. `web`: Nginx reverse proxy, depends_on `api` với điều kiện `service_healthy`.

### Biến Môi trường Trọng yếu (.env)

```env
NODE_ENV=production
PORT=3001
DATABASE_URL=file:./data.db
INSTANCE_MODE=single

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# Authentication & Encryption Secrets (bắt buộc >= 32 ký tự ở production)
JWT_ACCESS_SECRET=your_super_secret_access_key_min_32_characters_long
JWT_REFRESH_SECRET=your_super_secret_refresh_key_min_32_characters_long
MASTER_KEY=your_aes_master_key_for_api_key_encryption_32_chars

# Admin Bootstrap (tùy chọn seed tài khoản quản trị ban đầu)
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=admin_secure_password_min_12_chars

# AI Provider API Keys
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...

# Quota & Concurrency Guards
MAX_CONCURRENT_PROJECTS_PER_USER=2
PROJECT_RETENTION_DAYS=30
PROVIDER_RATE_LIMIT_SAFETY_MARGIN=0.8
QUOTA_WARNING_THRESHOLD=0.8
DEFAULT_PROVIDER_MODE=live

# Notification (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASSWORD=...
NOTIFY_FROM_EMAIL=no-reply@video-ai.local
```

---

## 4. Tự Phục Hồi & Giám sát Vận hành (Observability & Recovery)

### 4.1. Khởi động & Phục hồi Tự động (Startup Recovery)
- **`recoverStaleProjects`**: Quét các dự án đang ở trạng thái `running` bị gián đoạn do restart server, tự động đưa về `queued` để tiếp tục thực thi từ stage dở dang sớm nhất (`firstRunnableStage`).
- **`recoverUploadSessions`**: Khôi phục các phiên upload resumable chưa hoàn tất.
- **`sweepProjectCleanupTasks`**: Quét và tiếp tục các tác vụ dọn dẹp file tạm bị treo.

### 4.2. Giám sát Sức khỏe qua Endpoints
- **`GET /health`** (Liveness, luôn 200): Báo cáo trạng thái tiến trình, kết nối Redis (`connected`/`disconnected`), trạng thái hàng đợi BullMQ, tình trạng bộ nhớ đệm và chi tiết ghi đĩa `database.persistenceState` (`HEALTHY`, `DEGRADED`, `WRITE_BLOCKED`).
- **`GET /ready`** (Readiness): Trả về `200 { ready: true }` khi database an toàn; trả về `503 { ready: false }` khi database rơi vào trạng thái `WRITE_BLOCKED` để ngắt traffic kịp thời.

### 4.3. Single-Writer Lock & Chống Xung đột Ghi
- Tệp khóa `data.db.writer.lock` chứa metadata PID và hostname của tiến trình đang nắm giữ database. Nếu có tiến trình thứ hai cố tình khởi chạy cùng database, hệ thống sẽ báo lỗi rõ ràng và dừng lại ngay lập tức để tránh làm hỏng tệp SQLite.

---

## 5. Dọn dẹp Tài nguyên Tự động (Retention & Cleanup)

- **Outbox Pattern cho Xóa file (`project_cleanup_tasks`)**: Khi xoá dự án, bản ghi dọn dẹp được ghi vào database trước; worker sẽ dọn file thực tế trên ổ đĩa sau. Nếu xảy ra lỗi I/O, hệ thống sẽ tự động thử lại theo lịch.
- **Dọn dẹp theo thời hạn (`PROJECT_RETENTION_DAYS`)**: Tự động dọn các file tạm thời, video thô của các dự án đã hoàn thành quá thời hạn lưu trữ (mặc định 30 ngày) để giải phóng dung lượng đĩa.
