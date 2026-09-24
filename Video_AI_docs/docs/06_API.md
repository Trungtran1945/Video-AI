# 06 — REST API

> [CURRENT] — Base URL: `/api/v1`. Mọi endpoint (trừ `/auth/register`, `/auth/login`,
> `/auth/refresh`, `/auth/forgot-password`, `/auth/reset-password`) yêu cầu
> `Authorization: Bearer <accessToken>` (SSE dùng `?token=` — xem §2.2).
> Response thành công trả object/array trực tiếp (không bọc `{ data }`).
> Statuses lowercase: project `pending`/`queued`/`running`/`completed`/`failed`/`cancelled`;
> job `pending`/`running`/`success`/`failed`/`retry`/`cancelled`.
> Lỗi: `{ message, code, error: { code, message } }` (`backend/src/lib/httpError.js`).

---

## 1. Auth

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/auth/register` | không | `{ email, password, name? }` → `{ accessToken, refreshToken, user }` |
| POST | `/auth/login` | không | `{ email, password }` → tokens |
| POST | `/auth/refresh` | không (body `refreshToken`) | rotate → tokens mới |
| POST | `/auth/logout` | AUTH | thu hồi refresh |
| GET | `/auth/me` | AUTH | user hiện tại (EXTRA: đã cài đặt, chưa document trước đây) |
| POST | `/auth/forgot-password` | không | `{ email }` → message chung (EXTRA: đã cài đặt, chưa document trước đây) |
| POST | `/auth/reset-password` | không | `{ token, newPassword }` (EXTRA: đã cài đặt, chưa document trước đây) |

---

## 2. Projects (cả 2 mode)

### POST `/projects` — tạo & bắt đầu
```json
// SUMMARY
{
  "mode": "SUMMARY",
  "title": "Review Dune 2",
  "language": "vi",
  "style": "cinematic",
  "targetDurationSec": 1500,
  "params": { "tone": "nghiêm túc", "spoilerAllowed": false },
  "sourceVideoKey": "uploads/dune.mp4"   // đã upload trước
}
// TRANSLATE_DUB
{
  "mode": "TRANSLATE_DUB",
  "title": "Việt hoá anime short",
  "sourceLanguage": "auto",
  "targetLanguage": "vi",
  "stylePreset": "bat-trend",            // slug của 1 trong 13 StylePreset
  "enableDubbing": true,
  "voiceId": "vi-female-1",
  "maskMethod": "fill",                  // 'blur' | 'fill' | 'inpaint' (inpaint là premium)
  "maskStrength": 0.6,                   // 0–1: blur radius + độ đục lớp phủ (thanh kéo editor)
  "subPosition": "original",             // 'original' | 'top' | 'bottom' | 'custom'
  "sourceVideoKey": "uploads/short.mp4",
  "copyrightAcknowledged": true          // bắt buộc = true, xem `00` §5 và `03` §5
}
```
→ `202 Accepted` + `Project` (status `pending`, hoặc `queued` nếu user đã đạt giới hạn concurrency —
xem `03` §3 NFR-12).

### POST `/projects/:id/cancel` — huỷ pipeline đang chạy [CURRENT]
Không cần body. Huỷ mọi job `pending`/`running` của project, dọn file tạm liên quan.
→ `200 OK` + `Project` (status `cancelled` — không `FAILED`, `cancelled_at` được set).
Idempotent: gọi lại trên project đã kết thúc (`completed`/`failed`/`cancelled`) trả về
trạng thái hiện tại, không lỗi.

### POST `/projects/:id/translate-dub/confirm-preview` — xác nhận sau bước xem trước (TRANSLATE_DUB) [CURRENT]
Chạy sau khi `dub.translate` xong, trước khi enqueue `dub.ttsAlign`/`dub.render` (FR-J2 — xem `04` §4).
→ `202 Accepted`, enqueue render.
> Intended AUTH+OWNER. Lưu ý code: `confirmPreview.js` hiện chỉ gắn `requireProjectOwner`
> mà thiếu `authMiddleware` (mọi router còn lại đều `router.use(authMiddleware)`) —
> `req.user` sẽ undefined nếu gọi trực tiếp; docs ghi theo intended (sẽ bổ sung auth, không đổi contract).
> [PARTIAL] BE CURRENT nhưng FE orphan — `ProjectDetail` chưa gọi (chỉ có wrapper `api/projects.js:21`); xem `04` §4.

### GET `/projects` — danh sách (phân trang, filter `?mode=`) [CURRENT: trả array trực tiếp]
### GET `/projects/:id` — chi tiết (kèm stages, timeline/transcript, output) [CURRENT: trả object trực tiếp]
### GET `/projects/:id/timeline` — `TimelineClip[]` (SUMMARY) [CURRENT: array trực tiếp]
### GET `/projects/:id/transcript` — `{ revision, segments, outputStale }` (TRANSLATE_DUB) [CURRENT]
### PUT `/projects/:id/transcript` — body `{ revision, segments: [{ id, text?, translation?, startSec?, endSec? }] }`; `revision` bắt buộc, thiếu → 400, stale → 409 `CONFLICT_001`; trả `{ updated, revision, adjustedSegments, outputStale, segments }`
### PATCH `/projects/:id/segments/:segmentId/translation` — body `{ revision, translation }`; revision bắt buộc, gate hard → 422, stale → 409, trả segment + revision + outputStale
`transcript_version` là revision của source-of-truth `transcript_segments`. User PUT/PATCH và generated translation/dedupe chỉ bump khi state thực sự đổi; initial STT/OCR/cache import giữ revision khởi tạo; TTS linkage là derived metadata và không bump. Dub render stamp snapshot revision, Summary output dùng `null`.
### DELETE `/projects/:id` — xoá project + file [CURRENT, EXTRA: `projects.js:329-362`; 409 nếu pipeline đang chạy]
### GET/PUT `/projects/:id/mask-regions` — [NOT IMPLEMENTED: không route nào cài đặt] —
`OcrRegion[]`; PUT nhận region user chỉnh trên Canvas (`source='MANUAL'`)

Mỗi `OcrRegion` (lưu **tỷ lệ** scale-invariant, xem `02` §2):

```jsonc
{
  "id": "uuid",
  "startSec": 12.0, "endSec": 15.5,
  "ratioX": 0.05, "ratioY": 0.80, "ratioW": 0.90, "ratioH": 0.15, // 0.0–1.0 so với kích thước video
  "maskStrength": 0.6,   // 0–1: cường độ làm mờ (blur + độ đục lớp phủ)
  "isStatic": false,      // true: hardsub tĩnh → áp dụng cho toàn bộ duration (1 record)
  "text": "Original subtitle", "confidence": 0.91,
  "source": "AUTO"        // 'AUTO' (OCR) | 'MANUAL' (user khoanh)
}
```

- `GET` trả danh sách đã normalize (pixel cũ → ratio nếu DB còn bản ghi cũ).
- `PUT` body `{ regions: [...] }` upsert theo `id`; region `id` mới (`tmp_...`) → thêm `MANUAL`;
  `isStatic=true` → backend mở rộng `startSec=0, endSec=duration` khi render.
### POST `/projects/:id/regenerate` — chạy lại pipeline (từ stage lỗi hoặc đầu)

---

## 2.1. Upload resumable (dùng chung cho mọi file lớn) [CURRENT]

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/uploads/init` | AUTH | `{ filename, size, mime }`; `size` phải là positive safe integer ≤2GiB. Chỉ MP4/MOV/M4V/MKV/WebM. TTL idle mặc định 60 phút. → `{ uploadId, chunkSize }` (chunk 8MiB) |
| PUT | `/uploads/:id/chunk?offset=N` | AUTH | body `application/octet-stream`; raw parser 16MiB, chunk protocol ≤8MiB và không vượt declared remaining size. Offset phải khớp DB; request trùng offset → 409 `OFFSET_MISMATCH` (+ `expectedOffset`); xong → 204 + `Upload-Offset` |
| HEAD | `/uploads/:id` | AUTH | header `Upload-Offset`; session không tồn tại/foreign → 404, expired → 410 |
| POST | `/uploads/:id/complete` | AUTH | claim `pending→completing` với `storageKey` + SHA-256 trước rename; concurrent/repeated complete trả cùng `{ storageKey, url, filename, size, videoHash }` |
| POST | `/upload/` | AUTH | legacy multipart single file (limit 4GiB), stage trong `tmp`, kiểm tra extension/MIME/signature và FFprobe nếu có → `{ key, url, filename, size, mimetype }` |

State machine: `pending → completing → completed`; pending/completing hết TTL được cleanup thành `expired`. `completing` được startup/periodic recovery hoàn tất idempotently. `/storage` chỉ phục vụ đúng các shape media canonical, có `nosniff`, không follow symlink và không expose temp/private artifacts.

---

## 2.2. Real-time progress (SSE) [CURRENT]

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/projects/:id/events` | `?token=<accessToken>` (EventSource không gửi được Authorization header; `sseAuthMiddleware`) + OWNER | stream `text/event-stream` qua `eventBus`: `retry: 3000`, heartbeat `: ping` mỗi 15s, event `progress` `{ stage, status, percent }` (stage `__project__` là tiến độ tổng), event `done` + đóng stream khi project `success`/`failed` |

---

## 3. Generation (theo mode)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| POST | `/projects/:id/summary/start` | AUTH+OWNER | bắt đầu pipeline SUMMARY [CURRENT] |
| POST | `/projects/:id/translate-dub/start` | AUTH+OWNER | bắt đầu pipeline TRANSLATE_DUB [CURRENT: chạy sequential `runPipeline`, không enqueue song song] |
| GET | `/style-presets` | AUTH | danh mục phong cách dịch (slug, name, description) [CURRENT] |
| GET | `/projects/:id/jobs` | AUTH+OWNER | trạng thái từng stage (`GenerationJob[]`, array trực tiếp) [CURRENT] |
| POST | `/projects/:id/jobs/:type/retry` | AUTH+OWNER | retry thủ công 1 stage failed (resume từ stage lỗi earliest qua `firstRunnableStage`; quota cooldown → 429 `RETRY_WAITING`) [CURRENT] |
| GET | `/projects/:id/media-stages` | — | [NOT IMPLEMENTED: không route nào cài đặt] |
| POST | `/projects/:id/media-stages/:stage/retry` | — | [NOT IMPLEMENTED: không route nào cài đặt] |

---

## 3.1. Media Consent (TRANSLATE_DUB)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/projects/:id/media-consent` | — | [NOT IMPLEMENTED: không route nào cài đặt] |
| POST | `/projects/:id/media-consent` | — | [NOT IMPLEMENTED: không route nào cài đặt] |

> [NOT IMPLEMENTED] — Toàn bộ §3.1 + quy tắc consent/re-consent dưới đây là thiết kế tương lai,
> giữ nguyên không xoá.

**Quy tắc**:
- User PHẢI consent Terms mới nhất TRƯỚC khi tạo MediaJob.
- Nếu Terms version thay đổi → asset cũ đã consent vẫn dùng được cho Jobs đang chạy.
- `termsVersion` lấy từ hệ thống (admin config), không phải user tự nhập.

---

## 4. Outputs & Upload

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/outputs` | AUTH | thư viện video (`?projectId=`; mỗi row kèm `url` và `outputStale`) [CURRENT] |
| GET | `/outputs/:id` | AUTH (+owner/admin) | chi tiết + URL download + `outputStale` [CURRENT] |
| POST | `/outputs/:id/youtube` | AUTH+OWNER | `{ privacy }` → stub hàng đợi `youtube_uploads` `pending` (upload thật chưa gắn; idempotent) [CURRENT] |
| GET | `/outputs/:id/youtube` | AUTH+OWNER | trạng thái upload (row mới nhất hoặc `{ status: 'none' }`) [CURRENT] |

---

## 5. Queue & Analytics

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET | `/queue` | AUTH | 200 job gần nhất của user (toàn hệ nếu ADMIN) [CURRENT: array trực tiếp] |
| GET | `/analytics` | AUTH | `{ videos, totalProjects, completed, byMode, minutesTranslated, byProvider, byDay, jobStats }` [CURRENT: object trực tiếp] |
| GET | `/providers` | AUTH | provider theo nhóm `{ llm, asr, tts, vision, video }` + health 30d + `hasKey` [CURRENT] |
| GET | `/providers/:provider/quota` | AUTH | quota user hiện tại — dùng cho banner cảnh báo quota trên UI (`11` §4.1) [CURRENT] |

---

## 6. Settings / Keys / Logs (USER & ADMIN)

| Method | Path | Auth | Mô tả |
| --- | --- | --- | --- |
| GET/PUT | `/settings` | AUTH | cấu hình user (object trực tiếp) [CURRENT] |
| GET/POST | `/api-keys` | AUTH | quản lý API key (trả về đã mã hoá ẩn, kèm `keyPreview`); `POST` chấp nhận nhiều key cùng `provider` với `label`/`priority` khác nhau để round-robin (`11` §5) [CURRENT] |
| PUT | `/api-keys/:id` | AUTH | toggle `isActive` / sửa `label`/`tier`/`priority` (EXTRA: đã cài đặt, chưa document trước đây) [CURRENT] |
| DELETE | `/api-keys/:id` | AUTH | thu hồi [CURRENT] |
| GET | `/logs` | AUTH | `ProviderLog` (project của user / toàn hệ nếu ADMIN; array trực tiếp; `status 'ok'→'success'`, `type` map theo taxonomy frontend, gốc giữ ở `rawType`) [CURRENT] |
| GET/PUT | `/admin/users` | AUTH+ADMIN | quản lý user [CURRENT] |
| GET | `/admin/providers` | AUTH+ADMIN | stub `{ global: true, note }` — key per-user qua `/api-keys` [CURRENT] |

---

## 7. Ví dụ response `/projects/:id` (TRANSLATE_DUB) [CURRENT: object trực tiếp, statuses lowercase]

```json
{
  "id": "p_2",
  "mode": "TRANSLATE_DUB",
  "status": "running",
  "params": {
    "sourceLanguage": "auto", "targetLanguage": "vi",
    "stylePreset": "bat-trend", "enableDubbing": true,
    "maskMethod": "fill"
  },
  "jobs": [
    { "type": "dub.ingest", "status": "success" },
    { "type": "dub.stt", "status": "success" },
    { "type": "dub.translate", "status": "running", "progress": 62 }
  ],
  "transcriptPreview": [
    { "index": 0, "startSec": 0.4, "endSec": 3.1,
      "text": "おはよう", "translation": "Chào buổi sáng nha mấy bạ", "speaker": "SPK_1" }
  ],
  "ocrRegions": [
    { "id": "r_1", "startSec": 0.4, "endSec": 3.1,
      "ratioX": 0.0625, "ratioY": 0.9074, "ratioW": 0.4375, "ratioH": 0.0833,
      "maskStrength": 0.6, "isStatic": false, "source": "AUTO" }
  ],
  "output": null
}
```

---

## 8. Mã lỗi chuẩn [CURRENT: `{ message, code, error: { code, message } }`]

| Code | Ý nghĩa |
| --- | --- |
| `AUTH_001` | thiếu/thiếu hạn token |
| `AUTH_002` | không đủ quyền |
| `VAL_001` | validate thất bại (kèm field) |
| `PROJ_001` | project không tồn tại |
| `PROV_001` | provider lỗi (xem ProviderLog) |
| `JOB_001` | job thất bại không thể retry |
| `VAL_002` | chỉnh thời gian segment gây chồng lấn không thể tự động giải quyết (xem `03` §3 Overlap Detection) |
| `LIMIT_001` | user đã đạt giới hạn số project chạy đồng thời (`MAX_CONCURRENT_PROJECTS_PER_USER`); project được tạo với status `queued` |
| `COPYRIGHT_001` | thiếu xác nhận `copyrightAcknowledged` khi tạo project |
| `PROV_002` | tất cả API key của provider đã cạn quota (429/quota-exceeded); job chuyển `retry` với lịch chờ, xem `11` §4.2 |
| `RETRY_WAITING` | stage đang chờ quota hồi phục (`retry` + `next_retry_at` chưa tới) — [CURRENT, EXTRA] |
| `OFFSET_MISMATCH` | chunk offset lệch — resume từ `expectedOffset` — [CURRENT, EXTRA] |
| `INVALID_UPLOAD_SIZE` | declared upload size không phải positive safe integer |
| `CHUNK_TOO_LARGE` | chunk vượt 8MiB protocol limit |
| `CHUNK_EXCEEDS_REMAINING_SIZE` | chunk vượt số byte còn lại theo declared size |
| `UPLOAD_EXPIRED` | upload session đã hết idle TTL |
| `UNSUPPORTED_MEDIA_TYPE` | extension/MIME/signature không hợp lệ hoặc FFprobe không thấy video stream |
| `UPLOAD_RECOVERY_FAILED` | durable completion metadata không thể reconcile với filesystem |
| `PIPELINE_RUNNING` | pipeline đang chạy, không xoá/redub được — [CURRENT, EXTRA] |
| `MEDIA_001` | [TARGET/FUTURE: không cài đặt — upload CURRENT giới hạn 2GB resumable / 4GB legacy, không mã này] |
| `MEDIA_002` | [NOT IMPLEMENTED: media-consent chưa cài đặt] |
| `MEDIA_003` | [TARGET/FUTURE: MediaJobStage chưa cài đặt] |
| `MEDIA_004` | [TARGET/FUTURE: TTS voice check CURRENT chỉ warn-log khi tạo project, không chặn] |
| `MEDIA_005` | [TARGET/FUTURE: lệch slot xử lý ở `ttsAlign`/render validation, không mã này] |
| `MEDIA_006` | [TARGET/FUTURE: `tts_audio_ref` vs `dub_track_asset_id` chưa cài đặt] |

---

## 9. Swagger

- UI tại `/docs`. Mọi schema đồng bộ từ `packages/shared` (Zod → OpenAPI).
- Bảo vệ `/docs` bằng auth ADMIN trong production.
