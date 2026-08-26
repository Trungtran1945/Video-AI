# 04 — Thiết kế Frontend (Dashboard)

Frontend (`apps/web`) là **React 19 + Vite + TypeScript**, giao diện SaaS hiện đại, tối (dark mode),
thẻ bo góc, accent xanh, animation mượt (Framer Motion), responsive & mobile-friendly.

---

## 1. Công nghệ & nguyên tắc

- **TanStack Query** — fetch/cache API, polling tiến trình queue.
- **React Router** — routing trang.
- **React Hook Form + Zod** — form & validate (schema chia sẻ từ `packages/shared`).
- **shadcn/ui** — component tái dùng (Button, Card, Dialog, Tabs, Table...).
- **Framer Motion** — transition trang & widget.
- **State** — TanStack Query (server) + Context nhẹ (auth/user). Không dùng Redux nặng.

---

## 2. Cấu trúc thư mục

```
apps/web/
├── src/
│   ├── main.tsx
│   ├── App.tsx                # router + providers
│   ├── api/                   # axios client + typed endpoints
│   ├── auth/                  # AuthContext, ProtectedRoute, roles
│   ├── components/
│   │   ├── ui/                # shadcn (button, card, dialog...)
│   │   ├── layout/            # Sidebar, Topbar, Shell
│   │   ├── widgets/           # StatCard, QueueStatus, ProviderStatus...
│   │   └── player/            # VideoPlayer, TimelinePreview
│   ├── hooks/                 # useProjects, useQueue, useOutputs
│   ├── pages/
│   │   ├── Landing.tsx
│   │   ├── Login.tsx / Register.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Projects.tsx
│   │   ├── ProjectDetail.tsx
│   │   ├── CreateProject.tsx   # WIZARD
│   │   ├── Queue.tsx
│   │   ├── Outputs.tsx
│   │   ├── Settings.tsx
│   │   ├── ProviderSettings.tsx
│   │   ├── ApiKeys.tsx
│   │   ├── Logs.tsx
│   │   ├── Analytics.tsx
│   │   └── Admin.tsx
│   └── lib/                    # utils, constants, theme
```

---

## 3. Trang chính

| Trang | Mô tả |
| --- | --- |
| Landing | Giới thiệu 2 mode, CTA đăng ký |
| Login / Register | Auth (RHF + Zod) |
| Dashboard | Widget: video đã sinh, queue, storage, provider status, lịch sử |
| Projects | Danh sách project (filter theo mode), trạng thái |
| ProjectDetail | Xem pipeline stage, **TimelinePreview** (clip + player), output |
| CreateProject | **Wizard** (dưới) |
| Queue | Bảng job đang chạy/thất bại, retry thủ công |
| Outputs | Thư viện video, download, đẩy YouTube |
| Settings / ProviderSettings / ApiKeys | Cấu hình user & provider |
| Logs | Bảng ProviderLog (cost, token, status) |
| Analytics | Biểu đồ theo thời gian |
| Admin | Quản lý user, provider global, hệ thống |

---

## 4. Project Creation Wizard

Wizard 2 mode khác nhau:

### Mode `SUMMARY` (Review phim)
1. **Chọn mode** = SUMMARY.
2. **Upload phim** (2–3h), chọn ngôn ngữ.
3. **Độ dài** (20–30 phút).
4. **Phong cách / Giọng review** (tone: nghiêm túc, hài hước...; cho phép spoil?).
5. **Giọng đọc** (chọn voice provider + giọng).
6. **Generate** → gọi `POST /projects` + start.

### Mode `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng)
1. **Chọn mode** = TRANSLATE_DUB.
2. **Upload video** (≤ 2GB) — resumable, hiện % chunk đã nhận; rớt mạng resume không mất.
3. **Ngôn ngữ**: nguồn (auto-detect hoặc chọn) → đích (mặc định tiếng Việt).
4. **Phong cách dịch**: chọn 1 trong 12 StylePreset (card có mô tả + ví dụ văn phong).
5. **Lồng tiếng AI** (toggle): bật → chọn voice provider + giọng; tắt → chỉ thay phụ đề.
6. **Nâng cao** (tuỳ chọn): method che chữ `blur`/`fill`/`inpaint`, vị trí phụ đề mới.
7. **Generate** → start pipeline; theo dõi tiến trình realtime bằng SSE.

Wizard dùng `useWizard` (state machine đơn giản) + RHF mỗi bước; validate bằng Zod trước khi next.

---

## 4.1. SubRegionEditor (riêng TRANSLATE_DUB)

Sau khi stage `dub.ocr` xong, `ProjectDetail` hiển thị các OcrRegion tự động phát hiện đè lên
khung hình preview:

- Vẽ bằng **Canvas API** overlay trên `<video>` — user kéo/thêm/xoá/sửa bounding box
  (đặt đúng vùng hardsub mà OCR sót), đánh dấu `source='MANUAL'`.
- Preview từng region tại mốc thời gian: click region → player seek tới giữa `[startSec, endSec]`.
- "Dùng mặc định AI" nếu không muốn chỉnh tay; PUT `/projects/:id/mask-regions` trước khi render.
- Không phải editor timeline — chỉ chỉnh vùng chữ, giữ nguyên nguyên tắc tự động hoàn toàn.

## 4.2. Tiến trình real-time (SSE)

- Hook `useJobEvents(projectId)` mở **EventSource** tới `GET /projects/:id/events`
  (fallback polling TanStack Query nếu SSE lỗi).
- Mỗi event `{ stage, status, percent }` cập nhật stepper pipeline + progress bar không cần F5:
  ingest → stt ‖ ocr (hiện 2 nhánh song song) → translate → ttsAlign? → render.

---

## 5. TimelinePreview & TranscriptView (trọng tâm UX)

`ProjectDetail` hiển thị khác nhau theo mode:

**SUMMARY — TimelinePreview:** `TimelineClip[]` dạng track ngang:
- Mỗi clip: thumbnail (từ Scene), thời lượng, transition icon, đoạn giọng đọc tương ứng.
- Player đồng bộ: click clip → nhảy đến `startAtSec`.
- **Chỉ xem**, không edit (theo yêu cầu tự động hoàn toàn). User có thể "Regenerate" nếu không ưng.

**TRANSLATE_DUB — TranscriptView + SubRegionEditor:**
- Danh sách câu song ngữ (gốc ↔ bản dịch) theo timestamp; click câu → player seek tới `startSec`;
  badge speaker nếu có diarization.
- Kèm `SubRegionEditor` (mục 4.1) để chỉnh vùng che chữ trước render.

---

## 6. Widget Dashboard

- `StatCard` — tổng video đã sinh, tổng phút video đã Việt hoá.
- `QueueStatus` — số job running/failed (polling `/queue`).
- `StorageUsage` — dung lượng theo `storage/`.
- `ProviderStatus` — health từ `/providers`.
- `GenerationHistory` / `RecentOutputs` — danh sách mới nhất.

---

## 7. Giao tiếp API & type-safety

```ts
// apps/web/src/api/projects.ts
export const createSummary = (body: CreateSummaryInput) =>
  client.post<Project>('/projects', body).then(r => r.data);
```
Input type sinh từ Zod schema (`z.infer`) → **web & api đồng bộ kiểu**.

---

## 8. Quyết định frontend

| Quyết định | Lý do |
| --- | --- |
| TanStack Query thay Redux | ít boilerplate, cache & polling sẵn |
| Wizard state riêng | tách biệt mode, dễ mở rộng |
| TimelinePreview read-only | đúng yêu cầu tự động; vẫn cho Regenerate |
| Schema share từ packages/shared | type-safety đầu-cuối |
