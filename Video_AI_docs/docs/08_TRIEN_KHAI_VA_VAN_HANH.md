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
- SQLite sql.js file is mounted at `/app/data/data.db` via `db_data`; `DB_PATH` is explicit and `INSTANCE_MODE=single` is required.
- `/app/storage` phải là volume tin cậy, chỉ writer chính là API process; không cấp quyền ghi cho user/container khác trên host. Code kiểm tra symlink từng path component và không follow symlink, nhưng filesystem TOCTOU với một local attacker có quyền ghi storage vẫn nằm ngoài trust boundary.
- Legacy multipart dùng active-file registry trong API process; cleanup chỉ xóa staging file inactive quá 7 ngày và không xóa file đang stream.
- The optional `scale` worker is intentionally disabled (`scale-disabled`) and must not be used as a second sql.js owner.

### Dockerfile (api) [CURRENT — `docker/api.Dockerfile`]
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
Phục vụ tĩnh + reverse proxy `/api` → `asf-api`, `/docs` bảo vệ auth. Riêng `/api/v1/upload` và `/api/v1/uploads/*`, nginx cho phép body trên 4GiB để tính multipart overhead, không prebuffer request và dùng timeout xử lý dài cho hash/FFprobe. `/storage` được API lọc theo canonical media path; nginx không tự serve storage volume.

---

## 2. docker-compose.yml [CURRENT]

> [CURRENT] 3 service: `redis` (7-alpine) + `api` + `web`. SQLite file, không Postgres
> (không service `db`, không `pgdata`). Không có service `worker` riêng: API chạy queue
> workers in-process (`server.js`, `INSTANCE_MODE=single`) — container thứ hai dùng chung
> sql.js volume sẽ không giành được writer lock và crash-loop. Muốn scale worker phải
> thay sql.js bằng database client/server thật. Worker-per-stage (`worker-cpu`/`worker-gpu`,
> `docker/worker.Dockerfile`) là [TARGET/FUTURE].

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
      INSTANCE_MODE: single         # CURRENT: single-writer invariant
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:-}       # CURRENT: không secret mặc định —
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET:-}     # production fail-fast nếu thiếu
      MASTER_KEY: ${MASTER_KEY:-}
    volumes: [storage_data:/app/storage, db_data:/app/data]
    depends_on: [redis]              # condition: service_healthy
    healthcheck: [wget --spider http://localhost:3001/health]
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
DATABASE_URL=file:/app/data/data.db # CURRENT: SQLite file, single writer
DB_PATH=/app/data/data.db           # sql.js persistence path inside db_data volume
INSTANCE_MODE=single                # sql.js invariant; multi-process is rejected
DB_MAX_PENDING_WRITES=1000          # bounded process-local write queue
DB_SLOW_WRITE_MS=1000               # slow DB write telemetry threshold
PROJECT_LEASE_SECONDS=1800          # pending/running ownership lease
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

> [CURRENT] Node 22, `npm ci` từng app (không pnpm). Job `lint-and-test` chạy lint/test backend
> và lint/typecheck/build frontend. Job `docker-build` build hai image với `push: false`.

`.github/workflows/ci.yml`:
1. Checkout + setup Node 22.
2. `cd backend && npm ci` + `cd frontend && npm ci`.
3. Backend lint + `npm test`; frontend lint/typecheck/build; `docker compose config --quiet`.
4. Build API/web images with `push: false` on `main`.
5. Deployment/push remains outside the current CI workflow.

---

## 5. Scaling

- **Worker [CURRENT]**: no second sql.js writer is supported. The Compose `scale-disabled` profile is retained only to fail closed if someone attempts the old topology.
- **Single writer [CURRENT]**: one `node server.js` process owns `/app/data/data.db`; API, pipeline, and Redis workers run in that process.
- **Tách worker theo loại tài nguyên [TARGET/FUTURE]**: requires a shared transactional database and storage; it is incompatible with current sql.js in-memory state.
- **Auto-scale theo queue depth [TARGET/FUTURE]**: requires a shared database and worker-only process model.
- **Storage [TARGET/FUTURE]**: chuyển `STORAGE_DRIVER=s3` để chia sẻ giữa worker (bắt buộc khi scale nhiều node) — CURRENT chỉ lưu local (`storage/` + volume `storage_data`).
- **DB [TARGET/FUTURE]**: PostgreSQL hoặc native file-backed SQLite + connection/busy-timeout policy trước khi bật multi-process.

---

## 6. Giám sát & vận hành

- Log tập trung (Pino → file/stdout → công cụ log hệ thống).
- Metrics: BullMQ counts và `/health.database`/`/health.writes` (queue depth, wait time, duration, slow-write count).
- Cảnh báo: job FAILED quá N lần → notify admin.
- Backup: copy `data.db` only from the single owner during a quiesced window; do not use `pg_dump` for the current sql.js file.

### 6.1. Dọn dẹp tự động (Retention & Cleanup Cron)

> Vocab statuses UPPERCASE (`SUCCESS`/`FAILED`/`CANCELLED`) trong §6.1 là thiết kế [TARGET];
> [CURRENT] code dùng lowercase `completed`/`failed`/`cancelled` (xem `06` §1, `05` §E.1).

Do file nguồn (phim 2-3h, video ≤2GB) và file trung gian (mezzanine, audio tách, frame OCR) chiếm
dung lượng lớn, hệ thống chạy 1 cron job định kỳ (mỗi giờ, qua BullMQ repeatable job `cleanup.sweep`):

1. Quét `Project` có `expiresAt < now()` (mặc định `createdAt + PROJECT_RETENTION_DAYS`) và
   `status IN (SUCCESS, FAILED)` → xoá file trung gian trong `storage/tmp/{projectId}` qua
   `StorageProvider.delete`, giữ lại `Output` (video kết quả) trừ khi user xoá project hẳn.
   Upload resumable có lifecycle riêng: `UPLOAD_SESSION_TTL_MINUTES` (mặc định 60), startup recovery
   hoàn tất `completing`, expired `pending|completing` chỉ xóa canonical session temp directory rồi
   chuyển `expired`; completed upload không bị cleanup xoá. Legacy staging không dùng recursive temp
   sweep; file active được registry bảo vệ, file inactive cũ mới được xóa.

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
| Single writer cho sql.js | `sql.js` là in-memory database theo process; mọi API/pipeline/Redis worker chạy trong một `node server.js` |
| env qua secret Manager | bảo mật, không commit |
| SQLite file CURRENT / Postgres TARGET | CURRENT `DB_PATH=/app/data/data.db`, `INSTANCE_MODE=single`; multi-process cần DB transaction thật |
| CI chạy lint+test+typecheck+build | đúng `.github/workflows/ci.yml` hiện tại |
| Cron `cleanup.sweep` theo `expiresAt` | Kiểm soát chi phí lưu trữ chủ động thay vì dọn thủ công (NFR-13) |
| Notification worker tách riêng khỏi pipeline chính | Lỗi gửi mail không ảnh hưởng trạng thái project; dễ scale độc lập |
| `DEFAULT_PROVIDER_MODE=mock` cho CI/dev | Kiểm thử luồng pipeline không phụ thuộc/tốn quota free tier bên ngoài (`11` §6) |
