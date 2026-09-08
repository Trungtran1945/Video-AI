# 06 — REST API

Tất cả endpoint (trừ `/auth`, `/docs`) yêu cầu `Authorization: Bearer <accessToken>`.
Response chuẩn: `{ data }` hoặc lỗi `{ error: { code, message } }`.
Base URL: `/api/v1`.

---

## 1. Auth

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/auth/register` | `{ email, password }` → `{ user, accessToken, refreshToken }` |
| POST | `/auth/login` | `{ email, password }` → tokens |
| POST | `/auth/refresh` | `{ refreshToken }` → tokens mới (rotate) |
| POST | `/auth/logout` | thu hồi refresh |

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
→ `202 Accepted` + `Project` (status `PENDING`, hoặc `QUEUED` nếu user đã đạt giới hạn concurrency —
xem `03` §3 NFR-12).

### POST `/projects/:id/cancel` — huỷ pipeline đang chạy
Không cần body. Huỷ mọi job `PENDING`/`RUNNING` của project, dọn file tạm liên quan.
→ `200 OK` + `Project` (status `FAILED`, `cancelledAt` được set). Idempotent: gọi lại trên project
đã kết thúc trả về trạng thái hiện tại, không lỗi.

### POST `/projects/:id/translate-dub/confirm-preview` — xác nhận sau bước xem trước (TRANSLATE_DUB)
Chạy sau khi `dub.translate` xong, trước khi enqueue `dub.ttsAlign`/`dub.render` (FR-J2 — xem `04` §4).
Body tuỳ chọn `{ regions: [...] }` để cập nhật mask lần cuối (tương đương PUT mask-regions gộp bước).
→ `202 Accepted`, enqueue render.

### GET `/projects` — danh sách (phân trang, filter `?mode=`)
### GET `/projects/:id` — chi tiết (kèm stages, timeline/transcript, output)
### GET `/projects/:id/timeline` — `TimelineClip[]` (SUMMARY)
### GET `/projects/:id/transcript` — `TranscriptSegment[]` + bản dịch (TRANSLATE_DUB)
### GET/PUT `/projects/:id/mask-regions` — `OcrRegion[]`; PUT nhận region user chỉnh trên Canvas (`source='MANUAL'`)

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

## 2.1. Upload resumable (dùng chung cho mọi file lớn)

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/uploads/init` | `{ filename, size, mime }` → `{ uploadId, chunkSize }` (chunk 5–10MB) |
| PUT | `/uploads/:uploadId/chunk?offset=N` | đẩy 1 chunk tại offset; idempotent theo offset |
| HEAD | `/uploads/:uploadId` | trả offset đã nhận — client resume sau rớt mạng |
| POST | `/uploads/:uploadId/complete` | ghép chunk → trả `storageKey` dùng cho POST /projects |

---

## 2.2. Real-time progress (SSE)

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/projects/:id/events` | stream `text/event-stream`: `{ stage, status, percent }` từng job; worker publish qua Redis pub/sub |

---

## 3. Generation (theo mode)

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/projects/:id/summary/start` | bắt đầu pipeline SUMMARY |
| POST | `/projects/:id/translate-dub/start` | bắt đầu pipeline TRANSLATE_DUB (enqueue dub.stt ‖ dub.ocr song song) |
| GET | `/style-presets` | danh mục 13 phong cách dịch (slug, name, description) |
| GET | `/projects/:id/jobs` | trạng thái từng stage (`GenerationJob`) |
| POST | `/projects/:id/jobs/:type/retry` | retry thủ công 1 stage |

---

## 4. Outputs & Upload

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/outputs` | thư viện video (`?projectId=`) |
| GET | `/outputs/:id` | chi tiết + URL download (signed) |
| POST | `/outputs/:id/youtube` | `{ privacy }` → enqueue upload YouTube (OAuth user) |
| GET | `/outputs/:id/youtube` | trạng thái upload |

---

## 5. Queue & Analytics

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/queue` | job đang chạy/thất bại (toàn hệ với ADMIN) |
| GET | `/analytics` | `{ videos, minutesTranslated, byProvider, byDay }` |
| GET | `/providers` | danh sách provider + health status |
| GET | `/providers/:provider/quota` | `{ usedToday, limitToday, usedThisMinute, limitThisMinute, percentUsed }` theo user hiện tại — dùng cho banner cảnh báo quota trên UI (`11` §4.1) |

---

## 6. Settings / Keys / Logs (USER & ADMIN)

| Method | Path | Mô tả |
| --- | --- | --- |
| GET/PUT | `/settings` | cấu hình user |
| GET/POST | `/api-keys` | quản lý API key (trả về đã mã hoá ẩn); `POST` chấp nhận nhiều key cùng `provider` với `label`/`priority` khác nhau để round-robin (`11` §5) |
| DELETE | `/api-keys/:id` | thu hồi |
| GET | `/logs` | `ProviderLog` (project của user / toàn hệ nếu ADMIN) |
| GET/PUT | `/admin/users` | quản lý user (ADMIN) |
| GET | `/admin/providers` | cấu hình provider global (ADMIN) |

---

## 7. Ví dụ response `/projects/:id` (TRANSLATE_DUB)

```json
{
  "data": {
    "id": "p_2",
    "mode": "TRANSLATE_DUB",
    "status": "RUNNING",
    "params": {
      "sourceLanguage": "auto", "targetLanguage": "vi",
      "stylePreset": "bat-trend", "enableDubbing": true,
      "maskMethod": "fill"
    },
    "jobs": [
      { "type": "dub.ingest", "status": "SUCCESS" },
      { "type": "dub.stt", "status": "SUCCESS" },
      { "type": "dub.ocr", "status": "SUCCESS" },
      { "type": "dub.translate", "status": "RUNNING", "percent": 62 }
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
}
```

---

## 8. Mã lỗi chuẩn

| Code | Ý nghĩa |
| --- | --- |
| `AUTH_001` | thiếu/thiếu hạn token |
| `AUTH_002` | không đủ quyền |
| `VAL_001` | validate thất bại (kèm field) |
| `PROJ_001` | project không tồn tại |
| `PROV_001` | provider lỗi (xem ProviderLog) |
| `JOB_001` | job thất bại không thể retry |
| `VAL_002` | chỉnh thời gian segment gây chồng lấn không thể tự động giải quyết (xem `03` §3 Overlap Detection) |
| `LIMIT_001` | user đã đạt giới hạn số project chạy đồng thời (`MAX_CONCURRENT_PROJECTS_PER_USER`); project được tạo với status `QUEUED` |
| `COPYRIGHT_001` | thiếu xác nhận `copyrightAcknowledged` khi tạo project |
| `PROV_002` | tất cả API key của provider đã cạn quota (429/quota-exceeded); job chuyển `RETRY` với lịch chờ, xem `11` §4.2 |

---

## 9. Swagger

- UI tại `/docs`. Mọi schema đồng bộ từ `packages/shared` (Zod → OpenAPI).
- Bảo vệ `/docs` bằng auth ADMIN trong production.
