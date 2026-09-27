# Video-AI (AI Shorts Factory)

> Nền tảng SaaS tự động sản xuất video bằng AI với kiến trúc hàng đợi linh hoạt, thiết kế Provider Pattern đa mô hình và quy trình pipeline xử lý video hoàn toàn tự động.

---

## 📌 Mục lục

- [1. Giới thiệu tổng quan](#1-giới-thiệu-tổng-quan)
- [2. Hai chế độ sản xuất chính (Modes)](#2-hai-chế-độ-sản-xuất-chính-modes)
  - [2.1. SUMMARY (Review phim & Video tóm tắt)](#21-summary-review-phim--video-tóm-tắt)
  - [2.2. TRANSLATE_DUB (Dịch thuật & Lồng tiếng video)](#22-translate_dub-dịch-thuật--lồng-tiếng-video)
- [3. Tính năng nổi bật](#3-tính-năng-nổi-bật)
- [4. Kiến trúc hệ thống](#4-kiến-trúc-hệ-thống)
- [5. Cấu trúc thư mục](#5-cấu-trúc-thư-mục)
- [6. Hướng dẫn cài đặt & Khởi chạy](#6-hướng-dẫn-cài-đặt--khởi-chạy)
  - [6.1. Yêu cầu môi trường](#61-yêu-cầu-môi-trường)
  - [6.2. Chạy phát triển nội bộ (Local Development)](#62-chạy-phát-triển-nội-bộ-local-development)
  - [6.3. Khởi chạy bằng Docker Compose](#63-khởi-chạy-bằng-docker-compose)
- [7. Kiểm thử & Chất lượng mã nguồn](#7-kiểm-thử--chất-lượng-mã-nguồn)
- [8. Bản đồ API (API Reference)](#8-bản-đồ-api-api-reference)
- [9. Hệ thống tài liệu chi tiết](#9-hệ-thống-tài-liệu-chi-tiết)
- [10. Nguyên tắc phát triển (Guidelines)](#10-nguyên-tắc-phát-triển-guidelines)

---

## 1. Giới thiệu tổng quan

**Video-AI** (hay **AI Shorts Factory**) là giải pháp sản xuất video tự động hóa đầu cuối dành cho content creators, marketers và các nhà sáng tạo nội dung số.

Hệ thống hoạt động theo tôn chỉ: **Người dùng cấu hình đầu vào → AI thực thi pipeline đa tầng → Người dùng nhận thành phẩm hoàn chỉnh** (không yêu cầu dựng timeline thủ công phức tạp), nhưng vẫn cung cấp đầy đủ công cụ can thiệp tinh chỉnh (Manual Transcript Editor, Watermark/Subtitle Masking, Redubbing) khi cần kiểm soát chất lượng.

---

## 2. Hai chế độ sản xuất chính (Modes)

| Chế độ | Mục đích | Đầu vào | Quy trình & Đầu ra |
| :--- | :--- | :--- | :--- |
| **`SUMMARY`** | **Review phim / Video tóm tắt** | Video dài **2–3 tiếng** (phim, tài liệu, bài giảng) | Video tóm tắt **20–30 phút** cô đọng, tự động nhận diện cảnh (scene detection), sinh kịch bản review, thuyết minh AI và cắt dựng hình ảnh khớp với lời đọc. |
| **`TRANSLATE_DUB`** | **Dịch thuật & Lồng tiếng đa phong cách** | Video ngoại ngữ (≤ 2GB), chọn 1 trong **13 phong cách dịch** | Video giữ nguyên nhịp hình ảnh gốc, xóa/che phụ đề cũ (OCR mask), dịch phụ đề tiếng Việt tự nhiên và **lồng tiếng AI ép khớp thời lượng gốc (Forced Alignment TTS)**. |

### 2.1. SUMMARY (Review phim & Video tóm tắt)
Pipeline gồm 8 công đoạn tuần tự:
```
summary.transcribe ➔ summary.sceneDetect ➔ summary.analyze ➔ summary.script ➔ summary.align ➔ summary.tts ➔ summary.subtitle ➔ summary.render
```
- **Transcribe & Analyze**: Chuyển giọng nói gốc thành văn bản, dùng LLM phân tích cấu trúc mạch truyện và các cao trào.
- **Scene Detect**: Cắt video thành các phân đoạn cảnh (scene cut detection) bằng FFmpeg.
- **Script & Align**: Sinh kịch bản lời bình review, ghép nối nội dung lời đọc với các cảnh quay phù hợp nhất trong video gốc.
- **TTS & Render**: Tạo giọng thuyết minh, tạo phụ đề động ASS và xuất file video hoàn chỉnh.

### 2.2. TRANSLATE_DUB (Dịch thuật & Lồng tiếng video)
Pipeline gồm 6 công đoạn:
```
dub.ingest ➔ dub.stt (hoặc dub.ocr) ➔ dub.merge ➔ dub.translate ➔ dub.ttsAlign ➔ dub.render
```
- **13 Phong cách dịch thuật (`StylePreset`)**:
  1. `co-trang`: Cổ phong, kiếm hiệp cung đình ("bổn tọa", "hiền muội").
  2. `bat-trend`: Gen Z, tiếng lóng thịnh hành, phong cách viral.
  3. `review-phim`: Sắc sảo, góc nhìn điện ảnh, dí dỏm.
  4. `tinh-cam`: Nhẹ nhàng, học đường, xưng hô anh/em/bạn.
  5. `tai-lieu`: Chuẩn mực, trung tính, phong cách thuyết minh thời sự.
  6. `hai-huoc`: Hài hước, chơi chữ, tạo twist bất ngờ.
  7. `chinh-luan`: Nghiêm trang, ngữ pháp báo chí khách quan.
  8. `gaming`: Esports, năng lượng cao, thuật ngữ gaming streamer.
  9. `kinh-di`: Căng thẳng, rùng rợn, giật gân.
  10. `the-thao`: Sôi động, cảm thán, phong cách bình luận trực tiếp.
  11. `cong-nghe`: Chuẩn xác thuật ngữ kỹ thuật chuyên ngành.
  12. `tre-em`: Trong sáng, từ ngữ đơn giản, phù hợp gia đình.
  13. `sat-nghia`: Trung thành tuyệt đối với nguyên tác, giữ nguyên câu từ.
- **Phát hiện & Che phụ đề cũ (OCR Subtitle Mask)**: Tự động phát hiện vị trí phụ đề gốc qua OCR (Tesseract / Gemini Vision) hoặc vẽ vùng che thủ công.
- **Forced Alignment TTS Speed Adjustment**: Tự động điều chỉnh tốc độ đọc (speed stretch) hoặc rút gọn văn bản bằng LLM để giọng lồng tiếng khớp chính xác timestamp của từng câu nói trong video gốc.
- **In-Place Mutation & Redub**: Người dùng có thể sửa trực tiếp từng câu dịch (`PATCH /projects/:id/segments/:id/translation`) và kích hoạt quy trình lồng tiếng lại (`POST /projects/:id/translate-dub/redub`) mà không cần chạy lại STT/OCR.

---

## 3. Tính năng nổi bật

- **Upload Resumable chuẩn TUS-like**: Hỗ trợ upload video lớn phân mảnh theo chunk (16MB), có khả năng tạm dừng/tiếp tục và tự động phục hồi phiên tải lên khi khởi động lại backend.
- **Cập nhật thời gian thực qua Server-Sent Events (SSE)**: Theo dõi tiến độ từng công đoạn pipeline (`progress`, logs, stage transition) qua kết nối SSE bảo mật dùng vé tạm thời (`sse-ticket`), giảm tải cho client mà không cần polling liên tục.
- **Cơ chế chịu lỗi & Tự phục hồi (Fault-Tolerance & Recovery)**:
  - Dự án bị ngắt quãng do máy chủ khởi động lại sẽ được quét và tự động chuyển về hàng đợi để chạy tiếp từ công đoạn chưa hoàn thành (`firstRunnableStage`).
  - Hàng đợi dự phòng: Tự động hạ cấp sang polling nếu kết nối SSE bị gián đoạn.
- **Kiến trúc cơ sở dữ liệu an toàn**: Sử dụng `sql.js` (WebAssembly SQLite) với cơ chế ghi atomic memory + disk boundary, writer lock heartbeat (`data.db.writer.lock`), hàng đợi tuần tự hóa các tác vụ ghi và sao lưu tự động.
- **Bảo vệ tài nguyên & Rate Limit**: QuotaGuard cảnh báo ngưỡng sử dụng API, bộ nhớ đệm kết quả gọi nhà cung cấp AI (`provider_cache`) và cơ chế giãn cách gọi API (Rate Limit Margin) an toàn cho tài khoản Free Tier.

---

## 4. Kiến trúc hệ thống

```
┌────────────────────────────────────────────────────────┐
│                   FRONTEND (SPA)                       │
│     React 18 + Vite 6 + TailwindCSS + Radix/shadcn     │
│   TanStack Query v5 + Zustand + SSE Realtime Listener  │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP REST (/api/v1) & SSE
                            ▼
┌────────────────────────────────────────────────────────┐
│                   BACKEND (Node.js)                    │
│             Express 4 (ESM) + Middlewares              │
│  ┌───────────────────────┐  ┌───────────────────────┐  │
│  │    Pipeline Runner    │  │   Resumable Upload    │  │
│  │ (SUMMARY / TRANSLATE) │  │   (TUS-like chunks)   │  │
│  └───────────┬───────────┘  └───────────────────────┘  │
│              │                                         │
│  ┌───────────▼───────────┐  ┌───────────────────────┐  │
│  │   Provider Pattern    │  │   SQLite via sql.js   │  │
│  │ Gemini/OpenAI/EdgeTTS │  │ Memory+Disk Atomic IO │  │
│  └───────────────────────┘  └───────────────────────┘  │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
               ▼                           ▼
┌───────────────────────────┐ ┌───────────────────────────┐
│       REDIS 7 + BULLMQ    │ │       FFmpeg MODULE       │
│  Job queue, notifications │ │ Transcode, Scene Detect,  │
│      & cleanup workers    │ │ Speed Stretch, Conform    │
└───────────────────────────┘ └───────────────────────────┘
```

### Multi-Engine AI Provider Matrix

| Loại Provider | Nhà cung cấp hỗ trợ | Ghi chú |
| :--- | :--- | :--- |
| **LLM (Language)** | Google Gemini (`gemini-2.5-flash`), OpenAI GPT, Mock | Tóm tắt, dịch thuật theo StylePreset, rút gọn câu |
| **ASR (Speech-to-Text)** | OpenAI Whisper, Mock | Trích xuất âm thanh và nhận diện lời thoại |
| **TTS (Text-to-Speech)** | Microsoft Edge-TTS, ElevenLabs, Google TTS, OpenAI TTS, Mock | Edge-TTS miễn phí, tốc độ cao, hỗ trợ tiếng Việt mượt mà |
| **Vision & OCR** | Tesseract.js, Google Gemini Vision, Mock | Quét phụ đề cứng và phát hiện vùng văn bản trên video |
| **Translate** | Google Translate (Web/Script), LLM-based Direct Translation | Dịch câu ngắn và chuyển ngữ kịch bản |

---

## 5. Cấu trúc thư mục

```
Video_AI/
├── backend/                  # Máy chủ Node.js (Express ESM)
│   ├── scripts/              # Script kiểm tra redis (check-redis.mjs), test runner (run-tests.mjs)
│   ├── src/
│   │   ├── db/               # sql.js wrapper, schema, migration, seed, query queue
│   │   ├── lib/              # Tiện ích HTTP error, cache key, path validation, crypto
│   │   ├── media/            # FFmpeg wrapper (render, probe, concat, scene detection)
│   │   ├── middleware/       # JWT auth, project access, error handler, safe static media
│   │   ├── pipeline/         # Quản lý vòng đời pipeline, context, forced alignment
│   │   │   └── stages/       # Các công đoạn dub* và summary*
│   │   ├── providers/        # Triển khai Provider Pattern (Gemini, OpenAI, Edge-TTS, Tesseract)
│   │   ├── queue/            # BullMQ connection, queues và workers (drain, notify, cleanup)
│   │   ├── routes/v1/        # Các endpoints API REST v1
│   │   ├── services/         # Dịch vụ upload, admission, mutation, quota guard, output
│   │   ├── usecases/         # Luồng nghiệp vụ đặc thù (hủy project, v.v.)
│   │   ├── config.js         # Quản lý biến môi trường tập trung
│   │   └── server.js         # Điểm khởi chạy backend & worker
 │   ├── tests/                # Bộ kiểm thử tích hợp & hồi quy (84 test files)
│   └── package.json
├── frontend/                 # Giao diện người dùng (React 18 + Vite 6)
│   ├── src/
│   │   ├── api/              # Axios client, auth, upload, project api hooks
│   │   ├── components/       # UI components (timeline, player, wizard, modals, shadcn/ui)
│   │   ├── hooks/            # Custom React hooks (auth, SSE events, queries)
│   │   ├── lib/              # Hằng số, helper, cấu hình React Query, theme
│   │   ├── pages/            # Các trang chức năng (Dashboard, Projects, Detail, Settings...)
│   │   ├── App.jsx           # Routing & Router Guard
│   │   └── main.jsx
│   ├── vite.config.js        # Cấu hình proxy /api và /storage sang port 3001
│   └── package.json
├── docker/                   # Dockerfiles cho backend (api) và frontend (web Nginx)
├── Video_AI_docs/            # Tài liệu thiết kế hệ thống chi tiết từ đội ngũ kiến trúc
├── docker-compose.yml        # Điều phối các container (Redis, API, Web)
├── AGENTS.md                 # Hướng dẫn kiến trúc, kiểm thử & quy tắc mã nguồn cho AI Agents
└── README.md                 # Tài liệu hướng dẫn dự án (file này)
```

---

## 6. Hướng dẫn cài đặt & Khởi chạy

### 6.1. Yêu cầu môi trường

- **Node.js**: Phiên bản `18.x` hoặc `20.x` trở lên (khuyến nghị Node 20 LTS hoặc 22 LTS).
- **Redis**: Phiên bản `7.x` (cần thiết cho hàng đợi BullMQ).
- **FFmpeg**: Đã được cài đặt và có trong biến môi trường `PATH` (hoặc cấu hình đường dẫn qua `FFMPEG_PATH` trong file `.env`).
- **npm**: Phiên bản `9.x` trở lên.

### 6.2. Chạy phát triển nội bộ (Local Development)

#### Bước 1: Khởi động Redis
Cách thuận tiện nhất là khởi động dịch vụ Redis thông qua Docker:
```bash
docker compose up -d redis
```

#### Bước 2: Cấu hình và khởi chạy Backend
Di chuyển vào thư mục `backend`:
```bash
cd backend
npm install
```

Tạo file `backend/.env` dựa theo mẫu `backend/.env.example`:
```env
PORT=3001
NODE_ENV=development
STORAGE_DIR=./storage
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
COOKIE_SECURE=false

# Production bắt buộc (mỗi giá trị ≥32 ký tự — không dùng placeholder dưới đây):
# JWT_ACCESS_SECRET=...
# JWT_REFRESH_SECRET=...
# MASTER_KEY=...

# Cấu hình AI Provider Keys (điền key bạn có hoặc sử dụng mock)
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key

# Tùy chọn dịch thuật Google Apps Script (nếu có)
GOOGLE_TRANSLATE_SCRIPT_URL=
```

#### Biến môi trường bắt buộc (production)

| Biến | Mô tả |
|---|---|
| `JWT_ACCESS_SECRET` | Bí mật JWT access token (≥32 ký tự) |
| `JWT_REFRESH_SECRET` | Bí mật JWT refresh token (≥32 ký tự) |
| `MASTER_KEY` | Khối master cho dữ liệu nhạy cảm (≥32 ký tự) |
| `REDIS_HOST` / `REDIS_PORT` | Redis cho BullMQ (bắt buộc ở production — server exit(1) nếu không kết nối được) |
| `STORAGE_DIR` | Gốc storage (mọi path cleanup bị khoá trong đây) |
| `DB_PATH` | Đường dẫn SQLite (mặc định `backend/data.db`; hoặc `DATABASE_URL=file:...`) |
| `COOKIE_SECURE` | Tuỳ chọn: `true|false`, mặc định `true` khi `NODE_ENV=production` |

> Production fail-fast khi thiếu secret (`assertProductionSecrets` trong `backend/src/config.js` từ chối boot với secret thiếu/ngắn/dạng placeholder). Không ghi secret thật vào README hay git.

Kiểm tra kết nối Redis:
```bash
npm run check:redis
```

Khởi chạy backend server:
```bash
npm run dev
```
> Server sẽ khởi chạy tại `http://localhost:3001`. Cơ sở dữ liệu SQLite sẽ tự động khởi tạo và nạp dữ liệu mẫu ban đầu:
> - **Tài khoản Admin mặc định**: `admin@asf.local` / `admin1234`
> - **Dữ liệu**: Khởi tạo 13 phong cách dịch thuật `StylePreset`

#### Bước 3: Cấu hình và khởi chạy Frontend
Mở một cửa sổ dòng lệnh mới và di chuyển vào thư mục `frontend`:
```bash
cd frontend
npm install
npm run dev
```
> Giao diện người dùng sẽ chạy tại `http://localhost:5173`. Các yêu cầu đến `/api` và `/storage` được Vite tự động chuyển tiếp về backend port 3001.

---

### 6.3. Khởi chạy bằng Docker Compose

Dự án cung cấp sẵn cấu hình Docker Compose chuẩn hóa cho môi trường container:

```bash
docker compose up -d --build
```

Dịch vụ bao gồm:
- **`redis`**: Cổng `6379:6379`
- **`api`**: Cổng `3001:3001` (đã tích hợp sẵn FFmpeg trong container)
- **`web`**: Cổng `80:80` (Nginx phục vụ Frontend SPA và đóng vai trò Reverse Proxy)

Truy cập ứng dụng tại `http://localhost`.

---

## 7. Kiểm thử & Chất lượng mã nguồn

Hệ thống tuân thủ nghiêm ngặt quy trình kiểm thử trước khi bàn giao:

### Backend Tests (Regression Gate)
Chạy toàn bộ 84 file kiểm thử tích hợp (bao gồm kiểm tra upload resumable, tính toàn vẹn database, SSE, pipeline admission, logic kiểm tra ngôn ngữ, bảo mật đường dẫn và khôi phục lỗi):
```bash
cd backend
npm test
```
Kiểm tra code formatting & linting:
```bash
cd backend
npm run lint
```

### Frontend Checks
Kiểm tra cú pháp, lỗi lint và build hoàn chỉnh giao diện:
```bash
cd frontend
npm run lint
npm run build
npm run typecheck
```

---

## 8. Bản đồ API (API Reference)

Toàn bộ các API được định tuyến dưới tiền tố `/api/v1`:

### 8.1. Xác thực & Tài khoản (`/auth`)
- `POST /auth/register`: Đăng ký tài khoản người dùng mới.
- `POST /auth/login`: Đăng nhập, nhận Access Token (15m) & Refresh Token (7d).
- `POST /auth/refresh`: Cấp mới token khi hết hạn.
- `POST /auth/logout`: Hủy phiên đăng nhập.
- `GET /auth/me`: Lấy thông tin tài khoản hiện tại.
- `POST /auth/forgot-password` & `POST /auth/reset-password`: Quy trình khôi phục mật khẩu qua email token.

#### Xác thực
- Access token (JWT 15 phút): client giữ **trong bộ nhớ RAM** (không localStorage).
- Refresh token (7 ngày): **HttpOnly cookie** `refresh_token`, `Path=/api/v1/auth`, `SameSite=Lax`, `Secure` khi production. Rotation nguyên tử: mỗi `POST /auth/refresh` chỉ thành công đúng 1 lần cho mỗi token cũ (CAS).
- `POST /auth/refresh` vẫn nhận `refreshToken` trong body / header `x-refresh-token` như **fallback deprecated** — sẽ bị gỡ sau 2 release. Deploy cross-origin phải cùng-site hoặc dùng fallback này trong thời gian chuyển đổi.
- `POST /auth/logout` không yêu cầu access token còn hạn (xác thực bằng Bearer hoặc chính refresh cookie) — luôn xóa được cookie.
- `POST /auth/reset-password`: token một lần nguyên tử (claim trong transaction); đổi mật khẩu đồng thời thu hồi refresh token hiện tại.

### 8.2. Quản lý Dự án (`/projects`)
- `POST /projects`: Khởi tạo dự án mới (`SUMMARY` hoặc `TRANSLATE_DUB`).
- `GET /projects`: Danh sách dự án kèm trạng thái, tiến độ và phân trang.
- `GET /projects/:id`: Chi tiết dự án, tham số và kết quả từng công đoạn.
- `GET /projects/:id/timeline`: Dữ liệu timeline, transcript và cảnh quay.
- `POST /projects/:id/cancel`: Hủy thực thi pipeline đang chạy.
- `POST /projects/:id/regenerate`: Chạy lại dự án từ công đoạn lỗi sớm nhất.
- `DELETE /projects/:id`: Xóa dự án và các tệp tin lưu trữ liên quan.
- `POST /api/v1/projects`: header tùy chọn `Idempotency-Key` (1-128 ký tự, unique per user) — retry không tạo duplicate project, lần retry trả `idempotentReplay: true` cùng project id. Lỗi copy transcript cache → **202** với `transcriptCopyFailed: true` (project đã tồn tại, chạy `queued`).
- `DELETE /api/v1/projects/:id`: DB xóa nguyên tử + ghi task `project_cleanup_tasks` trong cùng transaction; file được dọn post-commit, thất bại → sweep mỗi 60s (backoff mũ, tối đa 10 lần, sau đó log ALERT). Không phụ thuộc Redis.
- `POST /api/v1/projects/:id/cancel`: cooperative — commit `cancelled` + hủy job trong 1 transaction, pipeline dừng ở ranh giới stage (không giết giữa chừng); gọi lại trên project đã xong là idempotent. `DELETE` khi pipeline đang chạy → `409`.
- `GET /health` → `{ status, redis, queueSystem, database, writes }` — dùng cho readiness probe.

### 8.3. Thực thi Pipeline (`/projects`)
- `POST /projects/:id/summary/start`: Kích hoạt pipeline cho dự án Review phim.
- `POST /projects/:id/translate-dub/start`: Kích hoạt pipeline Dịch thuật & Lồng tiếng.
- `POST /projects/:id/translate-dub/redub`: Lồng tiếng lại sau khi chỉnh sửa transcript.
- `GET /projects/:id/jobs`: Danh sách các job sinh dữ liệu (`generation_jobs`).
- `POST /projects/:id/jobs/:type/retry`: Thử lại một job cụ thể bị lỗi.

### 8.4. Dữ liệu Transcript & Tinh chỉnh dịch thuật
- `GET /projects/:id/transcript`: Lấy danh sách phân đoạn phụ đề và dịch thuật.
- `PUT /projects/:id/transcript`: Cập nhật hàng loạt transcript.
- `PATCH /projects/:id/segments/:segmentId/translation`: Chỉnh sửa câu dịch cụ thể (kèm cơ chế xác thực tránh mất nội dung).
- `GET /style-presets`: Danh sách 13 phong cách dịch thuật được hỗ trợ.

### 8.5. Tải lên video phân đoạn (Resumable Upload - TUS-like)
- `POST /uploads/init`: Khởi tạo phiên upload (`filename`, `fileSize`, `totalChunks`).
- `PUT /uploads/:id/chunk`: Tải lên một chunk nhị phân (gửi kèm header `X-Chunk-Index`).
- `POST /uploads/:id/complete`: Ghép nối các chunk, kiểm tra SHA-256 và sinh `storageKey`.

### 8.6. Che phủ phụ đề (Masks) & Sự kiện thời gian thực (SSE)
- `GET /projects/:id/masks`: Lấy danh sách vùng che watermark / subtitle.
- `POST /projects/:id/masks`: Thêm vùng che mới.
- `PATCH /projects/:id/masks/:maskId`: Cập nhật tọa độ vùng che.
- `DELETE /projects/:id/masks/:maskId`: Xóa vùng che.
- `POST /projects/:id/sse-ticket`: Tạo vé truy cập SSE ngắn hạn.
- `GET /projects/:id/events?ticket=...`: Kết nối Server-Sent Events nhận cập nhật tiến độ.

---

## 9. Hệ thống tài liệu chi tiết

Tài liệu đặc tả kiến trúc chuyên sâu được tổ chức trong thư mục `Video_AI_docs/docs/`:

| Tài liệu | Nội dung chi tiết |
| :--- | :--- |
| [`00_TAM_NHIN_VA_YEU_CAU.md`](Video_AI_docs/docs/00_TAM_NHIN_VA_YEU_CAU.md) | Tầm nhìn sản phẩm, yêu cầu chức năng & phi chức năng |
| [`01_KIEN_TRUC_TONG_THE.md`](Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md) | Kiến trúc tổng thể, luồng dữ liệu 2 pipeline, Clean Architecture |
| [`02_THIET_KE_CO_SO_DU_LIEU.md`](Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md) | Sơ đồ thực thể quan hệ (ERD), thiết kế bảng và ràng buộc |
| [`03_THIET_KE_BACKEND.md`](Video_AI_docs/docs/03_THIET_KE_BACKEND.md) | Kiến trúc tầng dịch vụ backend, bảo mật, quản lý phiên |
| [`04_THIET_KE_FRONTEND.md`](Video_AI_docs/docs/04_THIET_KE_FRONTEND.md) | Thiết kế giao diện người dùng, wizard tạo dự án, trình xem timeline |
| [`05_THIET_KE_PIPELINE_CHI_TIET.md`](Video_AI_docs/docs/05_THIET_KE_PIPELINE_CHI_TIET.md) | Thuật toán Align đồng bộ âm thanh, Forced Alignment, 13 phong cách dịch |
| [`06_API.md`](Video_AI_docs/docs/06_API.md) | Quy chuẩn REST API và hợp đồng request/response |
| [`07_MODULE_FFMPEG.md`](Video_AI_docs/docs/07_MODULE_FFMPEG.md) | Thiết kế module xử lý âm thanh/hình ảnh FFmpeg |
| [`08_TRIEN_KHAI_VA_VAN_HANH.md`](Video_AI_docs/docs/08_TRIEN_KHAI_VA_VAN_HANH.md) | Hướng dẫn triển khai Docker, giám sát, cấu hình môi trường |
| [`11_RATE_LIMIT_VA_FREE_TIER.md`](Video_AI_docs/docs/11_RATE_LIMIT_VA_FREE_TIER.md) | Cơ chế điều phối giới hạn tần suất gọi API (Rate Limit) cho Free Tier |

---

## 10. Nguyên tắc phát triển (Guidelines)

Dự án áp dụng triệt để **4 nguyên tắc lập trình của Andrej Karpathy** (quy định tại `AGENTS.md`):
1. **Think Before Coding**: Xác định rõ ràng các giả định, làm rõ các phương án đánh đổi trước khi viết mã.
2. **Simplicity First**: Giải pháp tối giản, không viết tính năng suy đoán ngoài yêu cầu, không trừu tượng hóa quá mức.
3. **Surgical Changes**: Chỉnh sửa chính xác phạm vi được yêu cầu, giữ nguyên phong cách mã nguồn hiện có, không refactor lan man.
4. **Goal-Driven Execution**: Luôn xác định tiêu chí thành công và kiểm chứng bằng bằng chứng thực tế từ test suite (`npm test`).
