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
| Dashboard | Widget: video đã sinh, credit, queue, storage, provider status, lịch sử |
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

### Mode `STYLE_EDIT` (Edit theo mẫu)
1. **Chọn mode** = STYLE_EDIT.
2. **Upload assets** (ảnh/video/audio).
3. **Upload video mẫu**.
4. **Độ dài** (30s–1phút), tỷ lệ (9:16).
5. **Phong cách** (lấy từ mẫu hoặc tuỳ chỉnh).
6. **Generate** → start pipeline.

Wizard dùng `useWizard` (state machine đơn giản) + RHF mỗi bước; validate bằng Zod trước khi next.

---

## 5. TimelinePreview (trọng tâm UX)

`ProjectDetail` hiển thị `TimelineClip[]` dạng track ngang:
- Mỗi clip: thumbnail (từ Scene/Asset), thời lượng, transition icon, đoạn giọng đọc tương ứng.
- Player đồng bộ: click clip → nhảy đến `startAtSec`.
- **Chỉ xem**, không edit (theo yêu cầu tự động hoàn toàn). User có thể "Regenerate" nếu không ưng.

---

## 6. Widget Dashboard

- `StatCard` — tổng video, credit đã dùng.
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
