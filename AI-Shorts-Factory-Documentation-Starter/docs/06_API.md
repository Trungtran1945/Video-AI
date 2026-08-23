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
// STYLE_EDIT
{
  "mode": "STYLE_EDIT",
  "title": "Short theo mẫu A",
  "language": "vi",
  "style": "from-template",
  "targetDurationSec": 45,
  "assetKeys": ["a1.jpg","a2.mp4","bgm.mp3"],
  "templateVideoKey": "templates/a.mp4"
}
```
→ `202 Accepted` + `Project` (status PENDING).

### GET `/projects` — danh sách (phân trang, filter `?mode=`)
### GET `/projects/:id` — chi tiết (kèm stages, timeline, output)
### GET `/projects/:id/timeline` — `TimelineClip[]` (xem trước)
### POST `/projects/:id/regenerate` — chạy lại pipeline (từ stage lỗi hoặc đầu)

---

## 3. Generation (theo mode)

| Method | Path | Mô tả |
| --- | --- | --- |
| POST | `/projects/:id/summary/start` | bắt đầu pipeline SUMMARY |
| POST | `/projects/:id/style-edit/start` | bắt đầu pipeline STYLE_EDIT |
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
| GET | `/analytics` | `{ videos, creditsUsed, byProvider, byDay }` |
| GET | `/providers` | danh sách provider + health status |

---

## 6. Settings / Keys / Logs (USER & ADMIN)

| Method | Path | Mô tả |
| --- | --- | --- |
| GET/PUT | `/settings` | cấu hình user |
| GET/POST | `/api-keys` | quản lý API key (trả về đã mã hoá ẩn) |
| DELETE | `/api-keys/:id` | thu hồi |
| GET | `/logs` | `ProviderLog` (project của user / toàn hệ nếu ADMIN) |
| GET/PUT | `/admin/users` | quản lý user (ADMIN) |
| GET | `/admin/providers` | cấu hình provider global (ADMIN) |

---

## 7. Ví dụ response `/projects/:id`

```json
{
  "data": {
    "id": "p_1",
    "mode": "SUMMARY",
    "status": "RUNNING",
    "targetDurationSec": 1500,
    "jobs": [
      { "type": "summary.transcribe", "status": "SUCCESS" },
      { "type": "summary.sceneDetect", "status": "SUCCESS" },
      { "type": "summary.script", "status": "RUNNING" }
    ],
    "timeline": [
      { "order": 0, "sourceType": "SCENE", "refId": "s_12",
        "inSec": 120.0, "outSec": 145.0, "speed": 1.0,
        "transitionOut": "cross", "startAtSec": 0.0 }
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

---

## 9. Swagger

- UI tại `/docs`. Mọi schema đồng bộ từ `packages/shared` (Zod → OpenAPI).
- Bảo vệ `/docs` bằng auth ADMIN trong production.
