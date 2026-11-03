# 06 — REST API v1

> Base URL: `/api/v1`. Mọi endpoint (trừ `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/forgot-password`, `/auth/reset-password`, `/youtube/oauth/callback`) yêu cầu header:
> `Authorization: Bearer <accessToken>`.
> SSE dùng vé ngắn hạn một lần qua `?ticket=` (sinh từ `POST /projects/:id/sse-ticket`).
> Response thành công trả JSON object/array trực tiếp (không bọc `{ data }`).
> Canonical status: `pending`, `queued`, `running`, `completed`, `failed`, `cancelled`.
> Lỗi chuẩn: `{ message, code, error: { code, message } }`.

---

## 1. Authentication (`/auth`)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/auth/register` | Không | `{ email, password, name? }` → `{ accessToken, user }` + HttpOnly cookie `refresh_token` |
| POST | `/auth/login` | Không | `{ email, password }` → `{ accessToken, user }` + HttpOnly cookie `refresh_token` |
| POST | `/auth/refresh` | Không (HttpOnly cookie) | Rotate token nguyên tử CAS → `{ accessToken, user }` + cookie mới. Chặn CSRF qua kiểm tra Origin/Referer allowlist |
| POST | `/auth/logout` | Cookie hoặc Bearer | Thu hồi refresh token trong DB và xoá HttpOnly cookie |
| GET | `/auth/me` | Bearer | Lấy thông tin tài khoản đang đăng nhập |
| POST | `/auth/forgot-password` | Không | `{ email }` → Gửi email hướng dẫn kèm token đặt lại mật khẩu |
| POST | `/auth/reset-password` | Không | `{ token, newPassword }` → Cập nhật mật khẩu mới qua token SHA-256 |

---

## 2. Quản lý Dự án (`/projects`)

### 2.1. POST `/projects` — Tạo & Khởi động Dự án
Body mẫu theo 3 chế độ:

```jsonc
// 1. Chế độ SUMMARY (Review phim & Tóm tắt)
{
  "mode": "SUMMARY",
  "title": "Review Phim Dune 2",
  "language": "vi",
  "style": "cinematic",
  "targetDurationSec": 1500,
  "sourceVideoKey": "uploads/dune2.mp4",
  "copyrightAcknowledged": true, // Bắt buộc
  "params": { "tone": "kịch tính", "spoilerAllowed": false }
}

// 2. Chế độ TRANSLATE_DUB (Dịch thuật & Lồng tiếng)
{
  "mode": "TRANSLATE_DUB",
  "title": "Việt hoá anime short",
  "sourceLanguage": "auto",
  "targetLanguage": "vi",
  "stylePreset": "bat-trend", // 1 trong 13 slug phong cách
  "enableDubbing": true,
  "audioMode": "DUB_MIX", // 'DUB_MIX' | 'DUB_REPLACE' | 'ORIGINAL_ONLY'
  "voiceId": "vi-female-1",
  "sourceVideoKey": "uploads/short.mp4",
  "copyrightAcknowledged": true
}

// 3. Chế độ SCRIPT_TO_VIDEO (Tạo video từ kịch bản)
{
  "mode": "SCRIPT_TO_VIDEO",
  "title": "5 Sự thật kỳ thú",
  "language": "vi",
  "aspectRatio": "16:9", // '16:9' | '9:16'
  "scriptUploadId": "uuid-script-upload",
  "copyrightAcknowledged": true
}
```
→ `202 Accepted` + `Project` (status: `pending`, hoặc `queued` nếu vượt quá giới hạn 2 project running / user).
- **Idempotency**: Hỗ trợ header tùy chọn `Idempotency-Key` (TTL 7 ngày), băm body thành `request_fingerprint` chống tạo trùng lặp.

### 2.2. Các thao tác trên Dự án

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/projects` | Bearer | Danh sách dự án (hỗ trợ phân trang `?page=&limit=` và lọc `?mode=`) |
| GET | `/projects/:id` | Bearer | Chi tiết dự án (kèm jobs, transcript, output, settings) |
| DELETE | `/projects/:id` | Bearer | Xóa dự án và đẩy task dọn file vào outbox `project_cleanup_tasks` |
| POST | `/projects/:id/cancel` | Bearer | Huỷ pipeline đang chạy an toàn (`status = 'cancelled'`) |
| POST | `/projects/:id/regenerate` | Bearer | Chạy lại pipeline tự động hoặc từ một stage chỉ định (`{ fromStage?: string }`) |
| GET | `/projects/:id/jobs` | Bearer | Trạng thái các stage `generation_jobs` của dự án |
| POST | `/projects/:id/jobs/:type/retry` | Bearer | Thử lại thủ công một stage bị lỗi |
| GET | `/projects/:id/timeline` | Bearer | Lấy danh sách `TimelineClip[]` (SUMMARY / SCRIPT_TO_VIDEO) |
| GET | `/projects/:id/script/segments/:segmentId/image` | Bearer | Phục vụ an toàn hình ảnh slide minh hoạ (BMP) của phân đoạn kịch bản (`requireProjectOwner`) |
| GET | `/projects/:id/script/segments/:segmentId/audio` | Bearer | Phục vụ an toàn tệp âm thanh giọng đọc MP3 của phân đoạn kịch bản (`requireProjectOwner`, stream MIME `audio/mpeg`) |
| PATCH | `/projects/:id/script/segments/:segmentId` | Bearer | Chỉnh sửa lời thoại (`narrationText`) và mô tả hình ảnh (`visualPrompt`) của phân đoạn kịch bản (kiểm tra `scriptVersion`) |
| POST | `/projects/:id/script/generate` | Bearer | Kích hoạt bắt đầu tạo video hoàn chỉnh từ kịch bản sau khi đã duyệt |

### 2.3. Chỉnh sửa Transcript & Vùng che Mask

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/projects/:id/transcript` | Bearer | `{ revision, segments, outputStale }` |
| PUT | `/projects/:id/transcript` | Bearer | Lưu hàng loạt câu thoại `{ revision, segments: [...] }` (tăng `transcript_version`) |
| PATCH | `/projects/:id/segments/:segmentId/translation` | Bearer | Sửa trực tiếp 1 câu dịch `{ revision, translation }` |
| POST | `/projects/:id/translate-dub/redub` | Bearer | Kích hoạt lồng tiếng lại từ transcript đã chỉnh sửa |
| GET | `/projects/:id/masks` | Bearer | Danh sách vùng che hardsub `MaskItem[]` |
| POST | `/projects/:id/masks` | Bearer | Tạo mask thủ công mới (`ratioX, ratioY, ratioW, ratioH, type, status`) |
| PATCH | `/projects/:id/masks/:maskId` | Bearer | Sửa mask (Mask `APPROVED` bị khoá sửa toạ độ `409 MASK_APPROVED_IMMUTABLE`) |
| DELETE | `/projects/:id/masks/:maskId` | Bearer | Xoá mask |

### 2.4. Real-time Progress qua SSE

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/projects/:id/sse-ticket` | Bearer | Sinh vé ngắn hạn một lần (TTL 30s) trong bảng `sse_tickets` → `{ ticket, expiresIn }` |
| GET | `/projects/:id/events?ticket=<ticket>` | Vé SSE | Stream `text/event-stream`: heartbeat `: ping` mỗi 15s, event `progress` `{ stage, status, percent }`, event `done` khi hoàn thành/lỗi/huỷ |

---

## 3. Tải lên tệp Media & Kịch bản

### 3.1. Resumable Upload kiểu TUS (`/uploads`)
Áp dụng cho mọi tệp video lớn (≤ 2GB), chia theo chunk 8MB cố định:

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/uploads/init` | Bearer | `{ filename, size, mime }` → Khởi tạo phiên tải lên, trả về `{ uploadId, chunkSize }` |
| PUT | `/uploads/:id/chunk?offset=N` | Bearer | Gửi chunk byte `application/octet-stream`. Offset phải khớp với dữ liệu máy chủ đã nhận |
| HEAD | `/uploads/:id` | Bearer | Trả về header `Upload-Offset` cho phép client kiểm tra và tiếp tục tải khi mất mạng |
| POST | `/uploads/:id/complete` | Bearer | Hoàn tất tải lên, kiểm tra băm SHA-256 và trả về `{ storageKey, videoHash, url }` |
| DELETE | `/uploads/:id` | Bearer | Huỷ phiên tải lên và dọn dẹp các chunk tạm |
| POST | `/upload` | Bearer | Legacy multipart tải lên tệp nhỏ (≤ 50MB) |

### 3.2. Script Upload (`/script-uploads`)
Áp dụng cho chế độ `SCRIPT_TO_VIDEO`:

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/script-uploads` | Bearer | Tải lên tệp kịch bản `.txt` hoặc `.md` (multipart field `file`, tối đa 2MB) → `{ id, filename, charCount, sha256, storageKey }` |

---

## 4. Tích hợp YouTube & Video Đầu ra

### 4.1. Outputs (`/outputs`)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/outputs` | Bearer | Thư viện video thành phẩm (`?projectId=`), kèm cờ `outputStale` và thông tin `youtubeUpload` |
| GET | `/outputs/:id` | Bearer | Chi tiết video, liên kết tải về trực tiếp kèm trạng thái `youtubeUpload` |

> **YouTube Output State:** Khi một video output đã từng được gửi yêu cầu xuất bản YouTube, payload của `GET /projects/:id` (thông qua `getOutputState`), `GET /outputs` và `GET /outputs/:id` sẽ tự động đính kèm đối tượng `youtubeUpload` chứa trạng thái mới nhất:
> ```json
> {
>   "id": "yt-upload-uuid",
>   "status": "completed | queued | uploading | processing | failed | cancelled",
>   "privacy": "private | unlisted | public",
>   "progress": 100,
>   "youtubeVideoId": "abc12345",
>   "youtubeVideoUrl": "https://youtu.be/abc12345",
>   "errorMessage": null,
>   "updatedAt": "2026-11-03T10:05:00.000Z"
> }
> ```
> Giao diện người dùng sử dụng trạng thái này để hiển thị huy hiệu YouTube thời gian thực (đang tải lên, link xem video, hoặc báo lỗi kèm nút thử lại).

### 4.2. Chỉnh sửa Kịch bản Sau Render & Tự động Chạy lại (Post-Render Workflow)
1. **Chỉnh sửa phân đoạn:** Người dùng có thể cập nhật `narrationText` và `visualPrompt` của từng phân đoạn bất kỳ lúc nào qua `PATCH /projects/:id/script/segments/:segmentId`.
2. **Cơ chế Output Stale:** Khi kịch bản được chỉnh sửa, hệ thống tăng `script_version` của dự án và gắn cờ `outputStale = true` (vì video đã render chưa phản ánh nội dung kịch bản mới nhất).
3. **Chạy lại tự động:** Khi gọi `POST /projects/:id/regenerate` mà không truyền `fromStage`, backend tự động phát hiện các giai đoạn chưa hoàn thành và tiếp tục từ `script.tts` (hoặc `script.image` nếu sửa prompt ảnh) thay vì chạy lại từ đầu.

### 4.3. YouTube OAuth & Upload (`/youtube`)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/youtube/oauth/start` | Bearer | Khởi tạo quy trình liên kết tài khoản YouTube (PKCE) |
| GET | `/youtube/oauth/callback` | Không | Callback nhận authorization code từ Google và lưu token |
| GET | `/youtube/account` | Bearer | Thông tin kênh YouTube đã liên kết |
| DELETE | `/youtube/account` | Bearer | Hủy liên kết tài khoản YouTube |
| POST | `/outputs/:id/youtube` | Bearer | Xuất bản video lên YouTube kèm lựa chọn quyền riêng tư (`public`, `unlisted`, `private`) |
| GET | `/outputs/:id/youtube` | Bearer | Lấy thông tin và trạng thái tiến trình xuất bản video lên YouTube (`queued`, `uploading`, `completed`, `failed`) |
| POST | `/outputs/:id/youtube/cancel` | Bearer | Huỷ tác vụ xuất bản video lên YouTube đang trong hàng đợi |

---

## 5. Quản trị, Giám sát & Nhà cung cấp

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/style-presets` | Bearer | Danh sách 13 phong cách dịch thuật dựng sẵn |
| GET | `/settings` / PUT `/settings` | Bearer | Đọc và cập nhật cài đặt mặc định của tài khoản |
| GET / POST | `/api-keys` | Bearer | Quản lý danh sách API key (Gemini, OpenAI, ElevenLabs...), hỗ trợ đa key round-robin |
| GET | `/providers` | Bearer | Danh sách provider theo từng nhóm năng lực `{ llm, asr, tts, vision, image }` |
| GET | `/providers/quota-summary` | Bearer | Tổng hợp mức sử dụng quota trong ngày của các provider |
| GET | `/queue` | Bearer | Danh sách các job gần nhất trong hệ thống hàng đợi BullMQ |
| GET | `/logs` | Bearer | Bảng nhật ký chi tiết các cuộc gọi `ProviderLog` |
| GET | `/analytics` | Bearer | Số liệu thống kê sản lượng video, thời lượng xử lý, phân bổ provider |
| GET | `/admin/users` | Admin | Quản lý danh sách người dùng |
| GET | `/admin/queue-metrics` | Admin | Thống kê số lượng job waiting/active trong BullMQ và fallback database |
| GET | `/admin/cleanup-tasks` | Admin | Danh sách các task dọn dẹp ổ đĩa trong outbox |

### 5.1. Liveness & Readiness Endpoints
- **`GET /health`** (Liveness, luôn HTTP 200): Báo cáo trạng thái tiến trình, tình trạng Redis (`connected`/`disconnected`), trạng thái ghi đĩa `database.persistenceState` (`HEALTHY`, `DEGRADED`, `WRITE_BLOCKED`) và hàng đợi ghi `writes`.
- **`GET /ready`** (Readiness): Trả về HTTP 200 `{ ready: true }` khi cơ sở dữ liệu `HEALTHY` hoặc `DEGRADED`; trả về **HTTP 503** khi `WRITE_BLOCKED` để các bộ cân bằng tải / orchestrator dừng điều hướng request ghi.
