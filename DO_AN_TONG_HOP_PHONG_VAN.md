# Tổng hợp đồ án Video-AI (AI Shorts Factory) — Cheat sheet phỏng vấn

> File này tổng hợp toàn bộ kiến thức về đồ án để bạn đọc và luyện phỏng vấn.
> Nguồn: README.md, AGENTS.md, Video_AI_docs/docs/*, backend/frontend source.

---

# MỤC LỤC

1. Đồ án là gì?
2. Công nghệ sử dụng
3. Kiến trúc tổng thể
4. Các chế độ sản xuất (Modes)
5. Luồng pipeline chi tiết
6. Backend chi tiết
7. Database (30 bảng)
8. Frontend chi tiết
9. API map
10. Tính năng nổi blatant
11. Upload resumable (TUS-like)
12. Realtime SSE
13. TRANSLATE_DUB end-to-end
14. Forced Alignment TTS
15. Mask (Subtitle Masking)
16. Database persistence & an toàn dữ liệu
17. Security
18. Testing & quality
19. Deployment
20. Câu hỏi phỏng vấn & gợi ý trả lời
21. Pitch 60 giây

---

# 1. Đồ án là gì?

**Video-AI / AI Shorts Factory** là nền tảng SaaS tự động sản xuất video bằng AI: người dùng đưa vào video dài/phim/kịch bản/tài nguyên → hệ thống tự chạy pipeline đa tầng (STT, dịch, TTS, render FFmpeg) → trả về video hoàn chỉnh. Người dùng vẫn có thể can thiệp thủ công (sửa transcript, vẽ mask che phụ đề, duyệt kịch bản, redub).

Đây là **full-stack product** (React SPA + Node.js Express + SQLite + Redis/BullMQ + FFmpeg + AI providers) có xử lý media thực, hàng đợi, realtime SSE, bảo mật và chịu lỗi.

---

# 2. Công nghệ sử dụng

## 2.1 Backend (`backend/`)
- **Runtime**: Node.js ≥18, ESM (`"type": "module"`).
- **Framework**: Express 4.
- **Database**: `sql.js` (SQLite chạy trên WebAssembly) — in-memory + atomic snapshot ra file `data.db`.
- **Queue**: BullMQ + Redis 7 (`ioredis`).
- **Media**: FFmpeg/ffprobe (wrapper `src/media/ffmpeg.js`, serialize process trên Windows).
- **Auth**: JWT (access 15m memory-only) + refresh token HttpOnly cookie 7d + bcryptjs.
- **Upload**: Resumable TUS-like (chunk 8MB, limit 2GB).
- **Realtime**: Server-Sent Events (SSE) + ticket ngắn hạn.
- **Email**: Nodemailer (OTP, reset password, notify).
- **AI providers**:
  - LLM: Google Gemini (`gemini-2.5-flash`), OpenAI GPT, Mock.
  - ASR: OpenAI Whisper, Mock.
  - TTS: Microsoft Edge-TTS, ElevenLabs, Google TTS, OpenAI TTS, ZeroTTS (Python sidecar), Mock.
  - Vision: Gemini Vision, Mock.
  - Translate: Google Translate (Apps Script/web), LLM-based.
- **Sidecar**: ZeroTTS Python (ONNX) tự khởi động trong `npm run dev`.

## 2.2 Frontend (`frontend/`)
- **React 18 + Vite 6** (HMR nhanh, proxy `/api`, `/storage` → `:3001`).
- **Styling**: Tailwind CSS + shadcn/ui (Radix primitives).
- **State**: TanStack Query v5 (server state), Zustand (timeline client state).
- **Motion**: Framer Motion.
- **Icons**: Lucide React.
- **Charts**: Recharts.
- **Forms**: React Hook Form + Zod.
- **Routing**: React Router v6.
- **3D/Canvas**: Three.js, HTML5 Canvas (MaskEditor).
- **Drag & drop**: `@hello-pangea/dnd`.

## 2.3 Hạ tầng
- Docker Compose: `redis`, `api` (3001), `web` (Nginx 80), `zerotts` (TTS inference).
- FFmpeg có sẵn trong container API.
- Storage volume local/Docker `/app/storage`.

---

# 3. Kiến trúc tổng thể

```
┌──────────────────────────────────────┐
│  FRONTEND (SPA) React 18 + Vite 6   │
│  TanStack Query + Zustand + SSE      │
└───────────────┬──────────────────────┘
                │ HTTP REST /api/v1 + SSE
                ▼
┌──────────────────────────────────────┐
│  BACKEND Express 4 (ESM)             │
│  ┌────────────┐  ┌───────────────┐  │
│  │ Pipeline   │  │ Resumable     │  │
│  │ Runner     │  │ Upload TUS    │  │
│  └─────┬──────┘  └───────────────┘  │
│        │                             │
│  ┌─────▼──────┐  ┌───────────────┐  │
│  │ Provider   │  │ SQLite sql.js │  │
│  │ Pattern    │  │ in-mem+disk   │  │
│  └────────────┘  └───────────────┘  │
└──────┬──────────────────────┬───────┘
       │                      │
       ▼                      ▼
┌──────────────┐      ┌──────────────┐
│ Redis 7 +    │      │ FFmpeg module│
│ BullMQ       │      │ transcode,   │
│ queues/workers│     │ scene detect │
└──────────────┘      └──────────────┘
```

**Nguyên tắc**: Clean Architecture + Provider Pattern. Provider được đăng ký trong `registry.js`, mọi gọi AI đi qua `callProvider()` (rate limit, cache, tracking, failover). Thêm provider mới = thêm 1 file implement + đăng ký, không sửa business logic.

---

# 4. Các chế độ sản xuất (Modes)

Hệ thống hỗ trợ 4 mode (3 chính thức + 1 legacy):

| Mode | Mục đích | Đầu vào | Đầu ra |
|------|----------|---------|--------|
| **MEDIA_COMPOSER** (Flagship) | Dựng video đa phương tiện đa rãnh | Ảnh, background, BGM, voiceover, kịch bản | Video MP4 Full HD đa lớp + ASS subtitle |
| **TRANSLATE_DUB** | Dịch thuật & lồng tiếng | Video ngoại ngữ ≤2GB, chọn 1/13 phong cách | Video giữ nguyên nhịp hình, phụ đề dịch + giọng lồng tiếng ép khớp thời lượng |
| **SCRIPT_TO_VIDEO** | Tạo video từ kịch bản | File `.txt` hoặc paste text | Video MP4 từ ảnh slide + voice + nhạc nền + phụ đề |
| **SUMMARY** (Legacy) | Review phim / video tóm tắt | Phim 2–3 giờ | Video tóm tắt 20–30 phút |

**13 phong cách dịch (StylePreset)**: `co-trang`, `bat-trend`, `review-phim`, `tinh-cam`, `tai-lieu`, `hai-huoc`, `chinh-luan`, `gaming`, `kinh-di`, `the-thao`, `cong-nghe`, `tre-em`, `sat-nghia`.

---

# 5. Luồng pipeline chi tiết

## 5.1. MEDIA_COMPOSER (3 stage)
```
composer.ingest → composer.prepare → composer.render
```
- **ingest**: validate tài nguyên; nếu timeline trống → `autoArrangeTimeline` xếp clip vào rãnh `MAIN_VIDEO`, tính `target_duration_sec`.
- **prepare**: scale/pad ảnh theo aspect ratio (16:9 hoặc 9:16), resample audio 48kHz stereo, biên dịch phụ đề ASS UTF-8.
- **render**: FFmpeg filtergraph đa lớp: Background blur + Slideshow zoom 1.05x + overlay; BGM loop vô hạn (`aloop`); dynamic sidechain ducking -12dB khi có voiceover; burn-in ASS; probe ffprobe; lưu output.

## 5.2. TRANSLATE_DUB (7 stage)
```
dub.ingest → dub.stt → dub.merge → dub.translate → dub.mask → dub.ttsAlign → dub.render
```
- **ingest**: demux audio/video, chuẩn hoá LUFS.
- **stt**: Whisper ASR + overlap stitching 15s giữa chunk, lọc ảo giác.
- **merge**: barrier kiểm tra dữ liệu (transcript, translation, duration, language).
- **translate**: TransFlow 3 vòng (Parallel Batch → Rescue Batch → Single Fallback), 13 StylePreset, kiểm soát rò rỉ CJK.
- **mask**: Vision phát hiện hardsub boxes hoặc nạp mask người dùng vẽ tay; chỉ mask `APPROVED` đưa vào render.
- **ttsAlign**: Forced Alignment TTS ép khớp slot gốc:
  - `TEMPO_MAX = 1.35`: Tốc độ co dãn tối đa giữ ở 1.35x để bảo toàn cao độ giọng nói tự nhiên.
  - **Pause-expansion**: Tận dụng khoảng lặng trước câu kế tiếp (`roomDur = Math.max(slotDur, nextStart - 0.06 - startSec)`) để giọng đọc không bị ép tăng tốc giả.
  - **Silence trimming**: Dùng FFmpeg `silenceremove` cắt 100-300ms im lặng thừa trước và sau câu thoại.
- **render**: burn mask APPROVED + phụ đề dịch burn ở đáy (`\an2`) + ducking audio + xuất MP4.

## 5.3. SCRIPT_TO_VIDEO (7 stage)
```
script.ingest → script.analyze → script.tts → script.image → script.align → script.subtitle → script.render
```
- **ingest**: kiểm tra toàn vẹn SHA-256, lưu `script/source.txt`.
- **analyze**: LLM phân tách thành `script_segments` (narration + visual prompt); fallback phân đoạn ngữ pháp nếu LLM không trả JSON.
- **Review Gate** (`script_review_required=1`): pipeline dừng ở `queued` để người dùng duyệt/sửa kịch bản, rồi `regenerate` để chạy tiếp.
- **tts/image**: sinh audio giọng đọc và ảnh slide minh họa từng phân đoạn.
- **align/subtitle/render**: căn thời lượng ảnh ↔ tiếng, tạo ASS/SRT, render MP4.

## 5.4. SUMMARY (Legacy, 8 stage)
```
summary.transcribe → summary.sceneDetect → summary.analyze → summary.script → summary.align → summary.tts → summary.subtitle → summary.render
```
- Transcribe + scene detect (FFmpeg) + Vision mô tả cảnh + LLM sinh kịch bản review + AlignService gói scene khớp thời lượng TTS + TTS + subtitle ASS + render.

---

# 6. Backend chi tiết

## 6.1. Cấu trúc thư mục
```
backend/src/
├── config.js            # env tập trung, CORS allowlist
├── db.js                # sql.js wrapper, atomic snapshot, single-writer lock, persistence health
├── db/ schema.js seed.js query.js
├── lib/                 # httpError, safePath, callProvider, providerFailover, rateLimiter, crypto...
├── media/               # ffmpeg.js, mediaService.js
├── middleware/          # auth, projectAccess, safeMediaStatic, sseAuth, cookieCsrf
├── pipeline/            # runner.js (4 mode), context, forcedAlignService, eventBus, stages/
├── providers/           # registry, tracked, rateLimit, asr/, llm/, tts/, vision/, translate/, image/
├── queue/               # BullMQ queues & workers (project, notify, cleanup, drain)
├── routes/v1/           # REST API v1
├── services/            # resumableUpload, composerService, projectAdmission, transcriptMutation, quotaGuard, ...
└── usecases/            # cancelProject, confirmPreview, createProject
```

## 6.2. Provider Pattern
- `registry.js` đăng ký provider theo `providerId`.
- `callProvider()` tự động: Rate Limiting (Token Bucket + Sliding Window), Provider Cache (SHA-256 input, TTL 90 ngày), Tracking vào `provider_logs`, Failover (`withProviderFailover`).

## 6.3. Database (sql.js)
- 30 bảng (xem §7).
- In-memory + flush atomic snapshot ra `data.db`.
- Single-writer lock file `data.db.writer.lock` (PID + hostname) chống xung đột đa tiến trình.
- Persistence health: `HEALTHY` / `DEGRADED` / `WRITE_BLOCKED` (khi quá số lỗi ghi → chặn ghi mới, `/ready` trả 503).
- Hàng đợi tuần tự hoá truy vấn ghi (`query.js`).

## 6.4. Hàng đợi & Worker (BullMQ + Redis)
- Queues: `projectQueue`, `notifyQueue`, `cleanupQueue`, `drainQueue`.
- Workers: `drainQueued`, `notifyWorker`, `cleanupWorker`, `youtubeUploadWorker`.
- Backend chạy degraded an toàn nếu Redis chưa bật (probe `/health`, `npm run check:redis`).

## 6.5. Các service cốt lõi
| Service | Vai trò |
|---------|---------|
| `composerService.js` | 5 rãnh timeline, upload/sắp xếp assets, OCR 2-tier cache, translate 2-tier cache, TTS voiceover, auto-arrange, save timeline |
| `resumableUploadService.js` | Upload TUS (chunk 8MB, 2GB), tự phục hồi session khi restart |
| `projectAdmission.js` | `run_token`, lease timeout, concurrency limit |
| `transcriptMutationService.js` | Cập nhật câu dịch/thời gian, tăng `transcript_version`, cờ `outputStale` |
| `quotaGuardService.js` | Kiểm tra quota provider trước stage |
| `projectCleanup.js` | Outbox durable tasks dọn file sau DELETE |
| `youtubeOAuthService` / `youtubePublishService` | OAuth PKCE Google + upload YouTube |
| `emailService.js` | SMTP Nodemailer |

## 6.6. Xử lý lỗi & chịu lỗi
- **Lỗi dữ liệu** (validation): fail-fast, không retry mù (`TRANSLATE_NEEDS_REVIEW`, `BLOCK_RENDER`).
- **Lỗi tạm thời** (503, timeout): retry exponential backoff theo policy.
- **Lỗi 429**: trích `Retry-After`, park project `queued`, hẹn `next_retry_at`.
- **Stale recovery**: `recoverStaleProjects()` chuyển project kẹt `running` → `queued`, chạy tiếp từ `firstRunnableStage`.
- **Cancel an toàn**: `AbortController`, dừng stage, dọn tmp, status `cancelled`.
- **Durable cleanup**: `project_cleanup_tasks` outbox, sweep mỗi 60s.

---

# 7. Database — 30 bảng

**Nhóm người dùng & bảo mật**: `users`, `reset_tokens`, `email_otps`, `api_keys`.

**Nhóm cấu hình & dự án**: `settings`, `projects`, `assets`, `generation_jobs`.

**Nhóm dữ liệu video & timeline**: `timeline_tracks`, `timeline_clips`, `scenes`, `script_segments`, `transcript_segments`, `ocr_regions`, `style_presets`, `project_glossaries`, `script_uploads`.

**Nhóm media đầu ra & xuất bản**: `audios`, `subtitles`, `outputs`, `youtube_uploads`, `youtube_accounts`, `youtube_oauth_states`.

**Nhóm quản trị & vận hành**: `provider_logs`, `provider_rate_limits`, `provider_cache`, `sse_tickets`, `project_idempotency`, `project_cleanup_tasks`, `upload_sessions`.

**Điểm nhấn thiết kế**:
- Không FK constraint cứng; dọn quan hệ trong code.
- Enums chữ thường (`pending/queued/running/completed/failed/cancelled`).
- `projects.transcript_version` cho optimistic concurrency + cờ `outputStale`.
- `run_token`, `lease_expires_at`, heartbeat cho lease ownership.
- `ocr_regions.status`: `DRAFT` / `APPROVED` / `DISABLED`; mask `APPROVED` bất biến.
- Indexes: `generation_jobs(project_id,type)` unique, `projects(user_id,status)`, `provider_cache(input_hash)`, v.v.

---

# 8. Frontend chi tiết

## 8.1. Công nghệ & cấu trúc
```
frontend/src/
├── api/          # Axios client, auth, projects, upload, outputs, extra
├── components/   # composer/, layout/, timeline/, ui/, MaskEditor.jsx, ErrorBoundary
├── hooks/        # useAuth, useJobEvents (SSE), queries
├── lib/          # constants, utils, AuthContext, tokenStore
├── pages/        # Dashboard, Projects, CreateProject, ProjectDetail, Outputs, ...
├── App.jsx       # Router + guard
└── main.jsx
```

## 8.2. Các trang chính
Dashboard, Projects (lọc mode/status), CreateProject (wizard 4 mode), ProjectDetail (trung tâm điều khiển), Outputs (thư viện video, cờ stale), Queue, ApiKeys (quota Free Tier), Logs (ProviderLog), Analytics, Admin.

## 8.3. Media Composer Studio (4 pane trong ProjectDetail)
1. **MediaLibrary**: upload kéo-thả nhiều file, reorder, OCR, translate, TTS.
2. **ComposerPreview**: preview canvas realtime hoặc video MP4 output.
3. **ClipInspector**: thuộc tính clip (thời gian, zoom, volume, text, toạ độ).
4. **Multi-Track Timeline 5 rãnh** (`BACKGROUND`, `MAIN_VIDEO`, `OVERLAY`, `VOICE`, `BGM`): trim hai đầu, snap-to-grid, zoom, Auto Arrange, Render Video.

## 8.4. Realtime & Editor
- SSE qua `useJobEvents`: ticket dùng 1 lần (`POST /sse-ticket`), kết nối `GET /events`; fallback polling khi gián đoạn.
- **Bilingual Transcript Editor** (TRANSLATE_DUB): sửa từng câu dịch; phát hiện `outputStale`; nút Redub.
- **MaskEditor Canvas**: vẽ vùng che hardsub (blur/solid), lifecycle `DRAFT`/`APPROVED`/`DISABLED`; mask APPROVED bất biến.
- **Review Gate** (SCRIPT_TO_VIDEO): bảng phân đoạn kịch bản, chỉnh sửa, tiếp tục.

## 8.5. Auth frontend
- Access token giữ trong RAM (không localStorage).
- Refresh token HttpOnly cookie, silent refresh khi 401.
- Zod validation, React Hook Form.

---

# 9. API map (rút gọn)

Base prefix `/api/v1`. Các nhóm:
- **Auth**: register, login, refresh, logout, me, forgot/reset password.
- **Projects**: CRUD, timeline, cancel, regenerate, delete, events (SSE), jobs/retry.
- **Pipeline**: summary/start, translate-dub/start, translate-dub/redub.
- **Transcript**: GET/PUT transcript, PATCH segment translation, GET style-presets.
- **Upload**: init, chunk, complete (TUS-like).
- **Masks**: CRUD vùng che.
- **SSE**: POST sse-ticket, GET events.
- **Health**: GET /health (liveness, persistenceState), GET /ready (503 khi WRITE_BLOCKED).
- Admin: cleanup-tasks, retry, queue metrics, users.

**Bảo mật**: JWT rotation CAS, CSRF nhẹ theo Origin/Referer, CORS fail-closed, path traversal protection (`isPathInside`, cấm symlink), safe static media `/storage/<key>`.

---

# 10. Tính năng nổi blatant

1. **Resumable upload TUS-like** (chunk 8MB, limit 2GB, tự phục hồi session).
2. **Realtime SSE** với vé dùng 1 lần nguyên tử (100 request đồng thời → đúng 1 success).
3. **Fault-tolerance**: stale project recovery, durable cleanup outbox, optimistic concurrency, graceful cancel.
4. **Forced Alignment TTS**: ép khớp thời lượng giọng lồng tiếng vào slot gốc (`TEMPO_MAX=1.35`, pause-expansion, silence trimming).
5. **Dynamic sidechain ducking** -12dB khi có voiceover.
6. **Mask lifecycle bất biến** (APPROVED immutable).
7. **Provider Pattern** + cache/rate limit/failover, hỗ trợ nhiều AI provider.
8. **sql.js atomic snapshot** + single-writer lock + persistence health.
9. **Idempotency** tạo project (Idempotency-Key, TTL 7 ngày).
10. **Retention cleanup** hourly sweep, không dọn project đang chạy.

---

# 11. Upload resumable (TUS-like) — chi tiết

## 11.1. Mục tiêu
Upload video lớn (≤2GB) ổn định trên mạng không ổn định: tạm dừng/tiếp tục, retry chunk, tự phục hồi khi server restart.

## 11.2. Trình tự
1. Client gọi `POST /uploads/init` với `{filename, fileSize, totalChunks}`.
2. Server tạo `upload_sessions` row: `status='pending'`, `received_bytes=0`, `expires_at`.
3. Client gửi từng chunk: `PUT /uploads/:id/chunk` kèm header `X-Chunk-Index`; body là binary chunk (8MB).
4. Server ghi chunk vào thư mục tạm, cập nhật `received_bytes`, `last_activity_at`.
5. Client resume: `HEAD /uploads/:id` (hoặc endpoint progress) để lấy `received_bytes`, gửi tiếp từ offset.
6. Kết thúc: `POST /uploads/:id/complete` → server verify SHA-256, ghép chunk, sinh `storageKey`, cập nhật `status='completed'`.

## 11.3. Tự phục hồi khi restart
- Khi server boot, upload recovery quét `upload_sessions` với `status='pending'` và `last_activity_at` gần đây → cho phép tiếp tục.
- Session hết hạn (`expires_at < now`) → `status='expired'`, client phải init lại.
- State machine: `pending → completing → completed|expired`.

## 11.4. Bảo mật & an toàn
- Mọi đường dẫn file được kiểm tra `isPathInside(STORAGE_DIR)` chống traversal.
- Không tin `out_path` từ client (legacy) — backend dùng binary response.
- Chunk size giới hạn, tổng dung lượng giới hạn 2GB.

**Câu phỏng vấn**: “Làm sao biết chunk nào đã upload?” → Theo dõi `received_bytes` + offset; client resume từ offset đó. “Nếu server crash giữa chừng?” → session lưu DB, restart recover.

---

# 12. Realtime SSE — chi tiết

## 12.1. Vì sao ticket dùng 1 lần?
- EventSource không hỗ trợ custom header → không gửi JWT qua header.
- Giải pháp: client gọi `POST /projects/:id/sse-ticket` (có JWT) → server tạo ticket ngắn hạn (TTL 30s), lưu `ticket_hash=sha256(ticket)` vào `sse_tickets`.
- Client mở `GET /projects/:id/events?ticket=...`.
- Server claim ticket nguyên tử: `DELETE ... WHERE ticket_hash AND used=0 AND expires_at>now AND project_id AND user_id`. 100 request đồng thời → đúng 1 success; sai project → 403 không đốt ticket.

## 12.2. Payload SSE
- Thanh tiến độ tổng quan `__project__` (progress 0–100).
- Trạng thái từng stage: `pending/running/completed/failed/retry`.
- Log/heartbeat.

## 12.3. Fallback polling
- Nếu SSE gián đoạn (mạng, proxy), frontend tự chuyển sang polling `GET /projects/:id/jobs` theo interval.
- Khi SSE khôi phục, chuyển lại SSE.

**Câu phỏng vấn**: “Tại sao không dùng WebSocket?” → SSE đủ cho one-way progress, nhẹ hơn, proxy-friendly, có fallback polling; WebSocket overkill cho use case này.

---

# 13. TRANSLATE_DUB end-to-end — ví dụ cụ thể

Giả sử user upload video tiếng Anh 5 phút, chọn style `bat-trend`, bật lồng tiếng Edge-TTS:

1. **Create project**: `POST /projects` mode=TRANSLATE_DUB, sourceVideoKey, stylePreset=bat-trend, enableDubbing=true, voiceId=edge vi.
2. **dub.ingest**: demux audio (ffmpeg), normalize LUFS, lưu audio track.
3. **dub.stt**: Whisper ASR → transcript_segments (start_sec, end_sec, text). Overlap stitching 15s giữa chunk để không mất câu ở biên.
4. **dub.merge**: barrier kiểm tra: transcript tồn tại, duration hợp lệ, language hợp lệ. Nếu thiếu → fail-fast `TRANSLATE_NEEDS_REVIEW`.
5. **dub.translate**: TransFlow 3 vòng:
   - Round 1: batch dịch song song theo context window.
   - Round 2: rescue các câu lỗi format/quality.
   - Round 3: single fallback từng câu.
   - Kiểm soát rò rỉ CJK (nếu còn ký tự CJK → retry/reject).
   - Lưu `translation` vào transcript_segments.
6. **dub.mask**: Nếu video có hardsub → Vision detect boxes hoặc user vẽ mask trên canvas → lưu ocr_regions `APPROVED`.
7. **dub.ttsAlign** (nếu enableDubbing):
   - Với mỗi segment, TTS sinh audio → đo durationSec.
   - Nếu durationSec > slotDur → tempo stretch tối đa 1.35x; nếu vẫn quá → pause-expansion tận dụng khoảng lặng trước câu kế tiếp; nếu vẫn quá → LLM rút gọn văn bản.
   - Silence trimming 100–300ms.
   - Lưu audios, gắn `tts_audio_id` vào segment.
8. **dub.render**:
   - Burn mask APPROVED (blur/solid).
   - Burn phụ đề dịch ở đáy (`\an2`).
   - Mix audio: voiceover + nhạc nền gốc (nếu DUB_MIX) với sidechain ducking -12dB.
   - Mux → MP4, probe ffprobe, lưu outputs.
9. SSE gửi progress từng stage → frontend cập nhật.
10. User có thể sửa câu dịch → PATCH segment → `transcript_version` tăng → cờ `outputStale` → Redub (chỉ chạy lại ttsAlign+render, không chạy lại STT).

**Điểm phỏng vấn**: “Tại sao Redub không chạy lại STT?” → Tiết kiệm chi phí/thời gian; STT đã có transcript gốc, chỉ cần dịch lại/TTS lại.

---

# 14. Forced Alignment TTS — thuật toán chi tiết

## 14.1. Vấn đề
TTS sinh audio có duration khác slot thời gian câu gốc. Nếu ép quá nhanh → méo giọng; nếu quá chậm → chồng chéo câu sau.

## 14.2. Giải pháp
- **Slot duration**: `slotDur = endSec - startSec`.
- **TTS duration**: `ttsDur` từ provider.
- Nếu `ttsDur <= slotDur`: đặt audio vào slot, thêm khoảng lặng.
- Nếu `ttsDur > slotDur`:
  1. Tempo stretch tối đa `TEMPO_MAX=1.35` → `stretchedDur = ttsDur / 1.35`. Nếu `stretchedDur <= slotDur` → dùng tempo 1.35 (hoặc thấp hơn).
  2. Nếu vẫn quá → **pause-expansion**: `roomDur = Math.max(slotDur, nextStart - 0.06 - startSec)` tận dụng khoảng lặng trước câu kế tiếp. Nếu `ttsDur <= roomDur` → đặt audio dài hơn slot (ăn vào khoảng lặng).
  3. Nếu vẫn quá → **LLM rút gọn văn bản** (shorten) rồi TTS lại.
- **Silence trimming**: `silenceremove` cắt 100–300ms im lặng đầu/cuối audio để không lãng phí slot.
- **Kết quả**: audio khớp slot, cao độ tự nhiên, không chồng chéo.

**Câu phỏng vấn**: “Tại sao tempo max 1.35 chứ không 2.0?” → Trên 1.35 giọng bắt đầu méo, mất tự nhiên; pause-expansion giải quyết phần còn lại.

---

# 15. Mask (Subtitle Masking) — chi tiết

## 15.1. Mục đích
Video có hardsub (phụ đề gốc burned-in). Cần che vùng đó để burn phụ đề dịch mới, tránh đè chữ.

## 15.2. Lifecycle
- `DRAFT`: bản nháp, có thể sửa toạ độ/thời gian.
- `APPROVED`: đã duyệt, **bất biến** (không sửa toạ độ/thời gian/kiểu). Muốn sửa → chuyển về DRAFT.
- `DISABLED`: tạm tắt, không áp dụng khi render.

## 15.3. Toạ độ
- Tỷ lệ scale-invariant: `ratioX, ratioY, ratioW, ratioH` (0–1) để mask đúng trên mọi resolution.
- Kiểu che: `blur` (bán kính mờ) hoặc `solid` (đổ màu nền).

## 15.4. Render
- Chỉ mask `APPROVED` + `enabled=1` được burn vào video.
- Mask `DRAFT`/`DISABLED` không xuất hiện trong output.

**Câu phỏng vấn**: “Tại sao mask APPROVED bất biến?” → Đảm bảo reproducibility: output render khớp đúng mask đã duyệt; nếu cho phép sửa sau APPROVED thì output cũ không còn khớp → nhầm lẫn. Muốn sửa phải quay về DRAFT và re-approve.

---

# 16. Database persistence & an toàn dữ liệu — chi tiết

## 16.1. sql.js in-memory
- Toàn bộ DB nạp vào RAM → query siêu nhanh.
- Mọi write đi qua `query.js` queue → serialize → flush atomic snapshot ra `data.db`.

## 16.2. Single-writer lock
- File `data.db.writer.lock` ghi PID + hostname của process sở hữu.
- Ngăn hai process ghi đè → corrupt DB.

## 16.3. Persistence health
- `HEALTHY`: ghi bình thường.
- `DEGRADED`: lỗi ghi tạm thời, chưa vượt ngưỡng.
- `WRITE_BLOCKED`: vượt ngưỡng lỗi ghi → chặn mọi write mới, `/ready` trả 503. Bảo vệ dữ liệu khỏi ghi vào DB hỏng.

## 16.4. Optimistic concurrency
- `projects.transcript_version` tăng khi sửa transcript/mask.
- `outputs.transcript_version` lưu version lúc render.
- Nếu lệch → `outputStale=true` → frontend cảnh báo render lại.

**Câu phỏng vấn**: “Tại sao không dùng PostgreSQL?” → Đồ án ưu tiên đơn giản triển khai local/single-node; sql.js atomic snapshot đủ cho scale nhỏ. Target tương lai Prisma+PostgreSQL cho scale lớn. Trade-off: single-writer, in-memory RAM.

---

# 17. Security — chi tiết

## 17.1. Auth
- Access token JWT 15m trong RAM (không localStorage) → XSS không đánh cắp được qua storage (vẫn có thể qua memory nhưng giảm rủi ro).
- Refresh token HttpOnly cookie 7d, `SameSite=Lax`, `Secure` prod. Rotation nguyên tử (CAS): mỗi refresh token chỉ dùng 1 lần.
- Logout không cần access token còn hạn (auth bằng Bearer hoặc cookie) → luôn xóa được cookie.
- Reset password: token one-time claim trong transaction, đổi mật khẩu + revoke refresh.

## 17.2. CSRF
- Cookie refresh/logout có lớp CSRF nhẹ theo Origin/Referer: cross-origin ngoài allowlist → 403 `CSRF_ORIGIN_MISMATCH`.

## 17.3. CORS
- Fail-closed: `CORS_ORIGINS` rỗng → mọi browser cross-origin bị reject (log warn 1 lần boot).
- Same-origin topology (nginx proxy) là khuyên dùng → cookie Lax đủ.

## 17.4. Path traversal
- `isPathInside(STORAGE_DIR)` + cấm symlink độc hại.
- Static media `/storage/<key>` qua `createSafeMediaStatic`.

## 17.5. Secrets
- Production fail-fast nếu thiếu/yếu secret (`assertProductionSecrets`).
- Không log secret; pipeline logs redacted.

**Câu phỏng vấn**: “Tại sao access token trong RAM?” → Giảm XSS persistence; refresh token HttpOnly → JS không đọc được. Trade-off: reload trang mất access token → silent refresh qua cookie.

---

# 18. Testing & quality

## 18.1. Backend
- `npm test` → `run-tests.mjs` chạy toàn bộ `backend/tests/*.test.mjs` (176 files).
- Bao gồm: upload resumable, DB integrity, SSE, pipeline admission, language checks, path security, recovery.
- `npm run lint` (eslint).

## 18.2. Frontend
- `npm run lint`, `npm run build`, `npm run typecheck` (tsc).
- Không có `npm test` → không invent.

## 18.3. Quy tắc kiểm chứng
- Contract: `frontend/src/api/*` phải khớp `backend/src/routes/`.
- Pipeline: chỉ check stage bị chạm + full backend suite regression.

**Câu phỏng vấn**: “Tại sao không có frontend test?” → Đồ án ưu tiên lint/build + E2E qua Playwright; unit test frontend chưa đầu tư. Đây là điểm có thể cải thiện.

---

# 19. Deployment

## 19.1. Local dev
1. `docker compose up -d redis`
2. `cd backend && npm install && npm run dev` (auto ZeroTTS)
3. `cd frontend && npm install && npm run dev` → `:5173`

## 19.2. Docker prod
- `cp .env.production.example .env` → sinh 3 secrets ≥32 chars → điền → `docker compose up -d --build`.
- Services: redis (internal), api `:3001`, web `:80` (Nginx SPA + reverse proxy), zerotts (ONNX, volume cache model).
- Topology same-origin: browser chỉ gọi `/`, nginx proxy `/api` → api. Cookie first-party.

## 19.3. Health checks
- `GET /health`: liveness (redis, bullmq, durableCleanup, cleanup stats, persistenceState, auth.refreshFallback).
- `GET /ready`: 200 nếu HEALTHY/DEGRADED, 503 nếu WRITE_BLOCKED.

---

# 20. Câu hỏi phỏng vấn thường gặp & gợi ý trả lời

**Q: “Mô tả kiến trúc tổng thể.”**
→ SPA React + Express API + sql.js (in-mem+disk) + Redis/BullMQ + FFmpeg + AI providers. Pipeline runner điều phối 4 mode. Clean Architecture + Provider Pattern.

**Q: “Làm sao xử lý video lớn?”**
→ Resumable TUS chunk 8MB ≤2GB, session lưu DB, resume từ offset, verify SHA-256 khi complete, recover khi restart.

**Q: “Realtime progress thế nào?”**
→ SSE với ticket one-time (claim nguyên tử), payload per-stage, fallback polling.

**Q: “Lồng tiếng khớp thời lượng thế nào?”**
→ Forced Alignment: tempo max 1.35, pause-expansion tận dụng khoảng lặng, silence trimming, LLM shorten nếu vẫn quá.

**Q: “Chịu lỗi thế nào?”**
→ Stale recovery, durable cleanup outbox, optimistic concurrency, graceful cancel, retry exponential, 429 park.

**Q: “Bảo mật?”**
→ JWT short-lived in RAM, refresh HttpOnly cookie rotation CAS, CSRF Origin check, CORS fail-closed, path traversal protection, prod fail-fast secrets.

**Q: “Scale?”**
→ Worker scale profile, Redis queues, provider cache/rate limit. Limit: single-writer DB (sql.js) → target PostgreSQL.

**Q: “Điểm yếu / cải thiện?”**
→ Chưa có frontend unit test; DB single-writer; target Prisma+Postgres; TypeScript migration (hiện JS).

---

# 21. Pitch 60 giây

> “Tôi xây dựng Video-AI, nền tảng SaaS tự động sản xuất video bằng AI. Frontend React 18 + Vite, backend Node/Express, DB sql.js với atomic snapshot, Redis/BullMQ cho heavy jobs, FFmpeg xử lý media, và nhiều AI provider (Gemini, OpenAI, Whisper, Edge-TTS...). Hệ thống hỗ trợ 4 mode: Media Composer đa rãnh, Translate+Dub với forced alignment TTS, Script-to-Video, và Summary. Điểm nhấn: upload resumable TUS, realtime SSE với ticket one-time, fault-tolerance (stale recovery, durable cleanup), mask lifecycle bất biến, và forced alignment ép khớp thời lượng lồng tiếng. Tôi cũng xử lý bảo mật (JWT rotation, CSRF, CORS fail-closed) và kiểm thử regression 176 test files.”

---

*File tổng hợp phục vụ luyện phỏng vấn. Cập nhật theo codebase hiện tại.*