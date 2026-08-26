# 08 — Triển khai và Vận hành

Hệ thống chạy production bằng **Docker** + **docker-compose**, CI qua **GitHub Actions**.

---

## 1. Docker

Mỗi app/build thành image riêng:

- `apps/api` → `asf-api` (Node 22-alpine, chạy `node dist`).
- `apps/web` → `asf-web` (build tĩnh → nginx).
- `packages/*` được build vào image api (monorepo, copy dist).
- `redis` (BullMQ), `postgres` (production DB).

### Dockerfile (api)
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm -r build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
CMD ["node", "apps/api/dist/index.js"]
```

### nginx (web)
Phục vụ tĩnh + reverse proxy `/api` → `asf-api`, `/docs` bảo vệ auth.

---

## 2. docker-compose.yml

```yaml
services:
  redis:
    image: redis:7-alpine
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: asf
      POSTGRES_USER: asf
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes: ["pgdata:/var/lib/postgresql/data"]
  api:
    build: { context: ., dockerfile: docker/api.Dockerfile }
    environment:
      DATABASE_URL: postgresql://asf:${DB_PASSWORD}@db:5432/asf
      REDIS_URL: redis://redis:6379
      JWT_SECRET: ${JWT_SECRET}
      MASTER_KEY: ${MASTER_KEY}
    depends_on: [redis, db]
  worker:
    build: { context: ., dockerfile: docker/worker.Dockerfile }
    command: ["node", "apps/api/dist/worker.js"]
    environment: *api_env
    depends_on: [redis, db]
  web:
    build: { context: ., dockerfile: docker/web.Dockerfile }
    ports: ["80:80"]
    depends_on: [api]
volumes:
  pgdata:
```

> MVP có thể thay `db` bằng sqlite file mount; production dùng postgres như trên.

---

## 3. Biến môi trường (.env)

Không hardcode secret. Ví dụ:

```env
DATABASE_URL=postgresql://asf:pass@db:5432/asf
REDIS_URL=redis://redis:6379
JWT_SECRET=...
JWT_REFRESH_SECRET=...
MASTER_KEY=...                      # AES-256 mã hoá API key
GEMINI_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
ELEVENLABS_API_KEY=...
HUGGINGFACE_TOKEN=...
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
STORAGE_DRIVER=local               # hoặc s3
AWS_S3_BUCKET=...
```

---

## 4. GitHub Actions (CI)

`.github/workflows/ci.yml`:
1. Checkout + pnpm setup.
2. `pnpm install --frozen-lockfile`.
3. `pnpm -r lint && pnpm -r typecheck`.
4. `pnpm -r test`.
5. Build image, push registry (chỉ nhánh `main`).
6. (Tuỳ chọn) deploy qua ssh / k8s.

---

## 5. Scaling

- **Worker**: scale ngang (`docker compose up --scale worker=4`). BullMQ tự cân bằng.
- **Tách worker theo loại tài nguyên**:
  - `worker-cpu` — ffmpeg (ingest, demux, mask hardsub, burn-in, mux). Render 1080p/4K ưu tiên
    **NVENC** (`h264_nvenc`) khi host có GPU NVIDIA.
  - `worker-gpu` — inference AI nặng: ASR/diarization, OCR frame sampling, TTS, inpainting
    (PyTorch/ONNX Runtime/TensorRT nếu self-host).
  - LLM translate gọi qua Provider API → không cần GPU node riêng.
- **Auto-scale theo queue depth**: đọc `queue.getJobCounts()` (BullMQ) → hàng đợi `dub.render` /
  `dub.ocr` ùn tắc vượt ngưỡng thì spawn thêm worker (K8s HPA/KEDA tự tạo Pod GPU mới), vãn khách
  tự thu hồi để tiết kiệm chi phí cloud.
- **Priority queue** (tuỳ chọn): job nhỏ / gói cao hơn được tiêu thụ trước khi burst traffic trend.
- **Storage**: chuyển `STORAGE_DRIVER=s3` để chia sẻ giữa worker (bắt buộc khi scale nhiều node).
- **DB**: PostgreSQL + connection pool; `ProviderLog` có thể chuyển warehouse riêng.

---

## 6. Giám sát & vận hành

- Log tập trung (Pino → file/stdout → công cụ log hệ thống).
- Metrics: số job/thời gian trung bình/queue depth (BullMQ Board hoặc Prometheus exporter).
- Cảnh báo: job FAILED quá N lần → notify admin.
- Backup: `pg_dump` định kỳ; volume `storage/` mount persistent.

---

## 7. Quyết định triển khai

| Quyết định | Lý do |
| --- | --- |
| Tách api & worker | worker render nặng không block API |
| env qua secret Manager | bảo mật, không commit |
| postgres production / sqlite MVP | nâng cấp không đổi schema |
| CI chạy lint+typecheck+test | đảm bảo chất lượng trước deploy |
