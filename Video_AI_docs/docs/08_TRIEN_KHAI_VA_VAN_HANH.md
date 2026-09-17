# 08 — Triển khai và Vận hành

Hệ thống chạy production bằng **Docker** + **docker-compose**, CI qua **GitHub Actions**.

---

## 1. Docker [CURRENT]

> [CURRENT] Code là JavaScript (không TypeScript/dist): backend `node server.js`, frontend build
> tĩnh bằng Vite. Không pnpm/monorepo — mỗi app `npm ci` riêng. Không Postgres/S3/worker-per-stage
> trong code (các ý đó là [TARGET/FUTURE]).

Mỗi app build thành image riêng:

- `docker/api.Dockerfile` → `asf-api` (Node 22-alpine + ffmpeg, `npm ci`, `CMD ["node", "server.js"]`;
  cả `api` và `worker` đều dùng image này — worker chỉ khác `command: ["node", "server.js"]`).
- `docker/web.Dockerfile` → `asf-web` (Node 22-alpine build Vite → nginx phục vụ tĩnh).
- `redis:7-alpine` (BullMQ).
- SQLite file (`DATABASE_URL=file:./data.db`, mount qua volume `db_data`) — không có service `db`/Postgres.

### Dockerfile (api) [CURRENT — `docker/api.Dockerfile`]
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --production=false
COPY backend/ ./backend/
RUN cd backend && npm run build 2>/dev/null || true   # không có script build → bỏ qua

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

### Dockerfile (web) [CURRENT — `docker/web.Dockerfile`]
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

### nginx (web)
Phục vụ tĩnh + reverse proxy `/api` → `asf-api`, `/docs` bảo vệ auth.

---

## 2. docker-compose.yml [CURRENT]

> [CURRENT] 4 service: `redis` (7-alpine) + `api` + `worker` (chung `docker/api.Dockerfile`) +
> `web`. SQLite file, không Postgres (không service `db`, không `pgdata`). Worker-per-stage
> (`worker-cpu`/`worker-gpu`, `docker/worker.Dockerfile`) là [TARGET/FUTURE].

```yaml
services:
  redis:
    image: redis:7-alpine            # CURRENT: redis:7, persistence appendonly
  api:
    build: { context: ., dockerfile: docker/api.Dockerfile }
    environment:
      DATABASE_URL: file:./data.db  # CURRENT: SQLite file, không postgres
      REDIS_HOST: redis
      REDIS_PORT: 6379
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:-change-me-in-production}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:-change-me-in-production}
      MASTER_KEY: ${MASTER_KEY:-change-me-in-production}
    volumes: [storage_data:/app/storage, db_data:/app/data]
    depends_on: [redis]              # condition: service_healthy
  worker:
    build: { context: ., dockerfile: docker/api.Dockerfile }  # CURRENT: chung image api
    command: ["node", "server.js"]
    environment: *api_env (REDIS_HOST/PORT, DATABASE_URL=file:./data.db, ...)
    depends_on: [redis, api]
    profiles: [scale]                # CURRENT: worker nằm trong profile `scale`
  web:
    build: { context: ., dockerfile: docker/web.Dockerfile }
    ports: ["80:80"]
    depends_on: [api]
volumes:
  redis_data:                        # CURRENT: redis_data + storage_data + db_data
  storage_data:
  db_data:
```

> [TARGET/FUTURE] Production Postgres (`db: postgres:16-alpine`, `DATABASE_URL=postgresql://…`)
> và `STORAGE_DRIVER=s3` — code hiện tại chỉ lưu local + SQLite file.

---

## 3. Biến môi trường (.env)

Không hardcode secret. Ví dụ:

```env
DATABASE_URL=file:./data.db         # CURRENT: SQLite file (TARGET: postgresql://asf:pass@db:5432/asf)
REDIS_HOST=redis                    # CURRENT: REDIS_HOST/PORT (không REDIS_URL)
REDIS_PORT=6379
JWT_ACCESS_SECRET=...               # CURRENT: cặp ACCESS/REFRESH (không JWT_SECRET đơn)
JWT_REFRESH_SECRET=...
MASTER_KEY=...                      # AES-256 mã hoá API key
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ELEVENLABS_API_KEY=...              # CURRENT: 3 provider key này (không ANTHROPIC/HUGGINGFACE/YOUTUBE*)
STORAGE_DRIVER=local               # [TARGET/FUTURE] `s3` chưa có trong code — CURRENT chỉ lưu local
AWS_S3_BUCKET=...                   # [TARGET/FUTURE] theo STORAGE_DRIVER=s3
MAX_CONCURRENT_PROJECTS_PER_USER=2 # NFR-12, xem `03` §3
PROJECT_RETENTION_DAYS=30          # NFR-13, xem `02` §5 và §6 dưới đây
SMTP_HOST=...                      # cho notify.projectDone (FR-J3, xem `01` §5.2)
SMTP_USER=...
SMTP_PASSWORD=...
NOTIFY_FROM_EMAIL=no-reply@ai-shorts-factory.example
PROVIDER_RATE_LIMIT_SAFETY_MARGIN=0.8   # xem `11_RATE_LIMIT_VA_FREE_TIER.md`
PROVIDER_CACHE_ENABLED=true
PROVIDER_CACHE_TTL_DAYS=90
QUOTA_WARNING_THRESHOLD=0.8
DEFAULT_PROVIDER_MODE=live              # 'live' | 'mock' — dùng 'mock' cho CI/dev, không tốn quota
```

---

## 4. GitHub Actions (CI) [CURRENT — `.github/workflows/ci.yml`]

> [CURRENT] Node 22, `npm ci` từng app (không pnpm). Job `lint-and-test` chạy lint backend
> (không có script → bỏ qua) + lint/typecheck/build frontend — **không chạy `npm test`**.
> Job `docker-build` (chỉ nhánh `main`) build 2 image với `push: false`, tags `asf-api:latest`
> và `asf-web:latest` — build-only, không push registry.

`.github/workflows/ci.yml`:
1. Checkout + setup Node 22.
2. `cd backend && npm ci` + `cd frontend && npm ci`.
3. Lint backend (tùy nghi) + `frontend: npm run lint && npm run typecheck && npm run build`.
4. Build image api (`docker/api.Dockerfile`, tags `asf-api:latest`) và web
   (`docker/web.Dockerfile`, tags `asf-web:latest`) với `push: false` (chỉ nhánh `main`).
5. [TARGET/FUTURE] Chạy test trong CI, push registry và deploy (ssh/k8s).

---

## 5. Scaling

- **Worker [CURRENT]**: 1 service `worker` chung image api (profile `scale`); scale ngang
  (`docker compose --profile scale up --scale worker=N`). BullMQ tự cân bằng.
- **Tách worker theo loại tài nguyên [TARGET/FUTURE]** (chưa có trong compose/code):
  - `worker-cpu` — ffmpeg (ingest, demux, mask hardsub, burn-in, mux). Render 1080p/4K ưu tiên
    **NVENC** (`h264_nvenc`) khi host có GPU NVIDIA.
  - `worker-gpu` — inference AI nặng: ASR/diarization, OCR frame sampling, TTS, inpainting
    (PyTorch/ONNX Runtime/TensorRT nếu self-host).
  - LLM translate gọi qua Provider API → không cần GPU node riêng.
- **Auto-scale theo queue depth**: đọc `queue.getJobCounts()` (BullMQ) → hàng đợi `dub.render` /
  `dub.ocr` ùn tắc vượt ngưỡng thì spawn thêm worker (K8s HPA/KEDA tự tạo Pod GPU mới), vãn khách
  tự thu hồi để tiết kiệm chi phí cloud.
- **Priority queue** (tuỳ chọn): job nhỏ / gói cao hơn được tiêu thụ trước khi burst traffic trend.
- **Storage [TARGET/FUTURE]**: chuyển `STORAGE_DRIVER=s3` để chia sẻ giữa worker (bắt buộc khi scale nhiều node) — CURRENT chỉ lưu local (`storage/` + volume `storage_data`).
- **DB [TARGET/FUTURE]**: PostgreSQL + connection pool — CURRENT là SQLite file (`db_data`).

---

## 6. Giám sát & vận hành

- Log tập trung (Pino → file/stdout → công cụ log hệ thống).
- Metrics: số job/thời gian trung bình/queue depth (BullMQ Board hoặc Prometheus exporter).
- Cảnh báo: job FAILED quá N lần → notify admin.
- Backup: `pg_dump` định kỳ; volume `storage/` mount persistent.

### 6.1. Dọn dẹp tự động (Retention & Cleanup Cron)

> Vocab statuses UPPERCASE (`SUCCESS`/`FAILED`/`CANCELLED`) trong §6.1 là thiết kế [TARGET];
> [CURRENT] code dùng lowercase `completed`/`failed`/`cancelled` (xem `06` §1, `05` §E.1).

Do file nguồn (phim 2-3h, video ≤2GB) và file trung gian (mezzanine, audio tách, frame OCR) chiếm
dung lượng lớn, hệ thống chạy 1 cron job định kỳ (mỗi giờ, qua BullMQ repeatable job `cleanup.sweep`):

1. Quét `Project` có `expiresAt < now()` (mặc định `createdAt + PROJECT_RETENTION_DAYS`) và
   `status IN (SUCCESS, FAILED)` → xoá file trung gian trong `storage/tmp/{projectId}` qua
   `StorageProvider.delete`, giữ lại `Output` (video kết quả) trừ khi user xoá project hẳn.
- Storage/S3 lifecycle rule tương đương cũng có thể cấu hình song song ở tầng hạ tầng cho production.
2. Với project `CANCELLED`/`FAILED` ngay sau khi huỷ (xem `01` §5.2), dọn file tạm **ngay lập tức**,
   không chờ tới chu kỳ cron.
3. Ghi log số byte đã giải phóng vào `ProviderLog`-style record (hoặc bảng `CleanupLog` riêng nếu cần
   audit) để theo dõi qua Analytics.

### 6.2. Notification Service

Worker riêng nhẹ (`notify` queue, không cần GPU/CPU nặng) tiêu thụ job `notify.projectDone`:
- Gửi email qua SMTP (cấu hình ở §3) khi `Project.status` chuyển `SUCCESS`/`FAILED`.
- Nội dung: tên project, trạng thái, link trực tiếp tới `ProjectDetail` hoặc `Outputs`.
- Không chặn pipeline chính; job này độc lập, retry riêng (2 lần), lỗi gửi mail không làm
  `Project.status` bị ảnh hưởng.

---

## 7. Quyết định triển khai

| Quyết định | Lý do |
| --- | --- |
| Tách api & worker | worker render nặng không block API |
| env qua secret Manager | bảo mật, không commit |
| SQLite file CURRENT / Postgres TARGET | CURRENT `DATABASE_URL=file:./data.db`; nâng cấp Postgres không đổi logic app |
| CI chạy lint+typecheck+build, không chạy test | đúng `.github/workflows/ci.yml` hiện tại (test chạy local bằng `npm test`) |
| Cron `cleanup.sweep` theo `expiresAt` | Kiểm soát chi phí lưu trữ chủ động thay vì dọn thủ công (NFR-13) |
| Notification worker tách riêng khỏi pipeline chính | Lỗi gửi mail không ảnh hưởng trạng thái project; dễ scale độc lập |
| `DEFAULT_PROVIDER_MODE=mock` cho CI/dev | Kiểm thử luồng pipeline không phụ thuộc/tốn quota free tier bên ngoài (`11` §6) |
