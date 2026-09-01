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
4. **Phong cách dịch**: chọn 1 trong 13 StylePreset (card có mô tả + ví dụ văn phong).
5. **Lồng tiếng AI** (toggle): bật → chọn voice provider + giọng; tắt → chỉ thay phụ đề.
6. **Nâng cao** (tuỳ chọn): method che chữ `blur`/`fill`/`inpaint` (inpaint là premium, xem `00`/`03`),
   vị trí phụ đề mới (`Giữ nguyên` / `Top` / `Bottom` / `Custom`), và `maskStrength` mặc định.
7. **Generate** → start pipeline; theo dõi tiến trình realtime bằng SSE.

Wizard dùng `useWizard` (state machine đơn giản) + RHF mỗi bước; validate bằng Zod trước khi next.

---

## 4.1. SubRegionEditor (riêng TRANSLATE_DUB)

Sau khi stage `dub.ocr` xong, `ProjectDetail` hiển thị các OcrRegion tự động phát hiện đè lên
khung hình preview:

- Vẽ bằng **Canvas API** overlay trên `<video>` — user kéo/thêm/xoá/sửa bounding box
  (đặt đúng vùng hardsub mà OCR sót), đánh dấu `source='MANUAL'`.
- **Tọa độ lưu theo TỶ LỆ %** (`ratioX/Y/W/H`, 0.0–1.0 so với kích thước video gốc) thay vì pixel
  tuyệt đối → vùng che tự co giãn, không bị lệch khi render ở độ phân giải khác (xem `02` §2).
- **Live preview hiệu ứng mask ngay trên player**: vùng được **làm mờ thực sự (blur)** + lớp phủ
  mờ, không còn thấy rõ chữ gốc. Có **thanh kéo `maskStrength` (0–1)** cho vùng đang chọn để tăng/giảm
  đồng thời bán kính blur và độ đục lớp phủ; giá trị lưu xuống `OcrRegion.maskStrength` để render khớp.
- **"Áp dụng cho toàn bộ video"** (tick `isStatic`): cho hardsub tĩnh (logo, credit chạy suốt),
  chỉ cần 1 record áp dụng từ `startSec=0` đến hết video — tránh sinh hàng chục region rời rạc.
- **"Gộp vùng" (Merge Regions)**: hợp nhiều region nhỏ cùng hardsub thành 1 bbox bao trùm.
- **Liên kết vị trí phụ đề mới**: khi user chọn che vùng hardsub, editor gợi ý/mặc định đặt phụ đề
  dịch trùng khớp hoặc nằm ngay **trên** vùng đã mask (safe zone) để thẩm mỹ; user có thể đổi sang
  "Giữ nguyên vị trí gốc" hoặc "Vị trí mới (Top/Bottom/Custom)" (xem `01` §3.2).
- Preview từng region tại mốc thời gian: click region → player seek tới giữa `[startSec, endSec]`.
- "Dùng mặc định AI" nếu không muốn chỉnh tay; PUT `/projects/:id/mask-regions` trước khi render.
- Không phải editor timeline — chỉ chỉnh vùng chữ, giữ nguyên nguyên tắc tự động hoàn toàn.

## 4.2. Tiến trình real-time (SSE)

- Hook `useJobEvents(projectId)` mở **EventSource** tới `GET /projects/:id/events`
  (fallback polling TanStack Query nếu SSE lỗi).
- Mỗi event `{ stage, status, percent }` cập nhật stepper pipeline + progress bar không cần F5:
  ingest → stt ‖ ocr (hiện 2 nhánh song song) → translate → ttsAlign? → render.

---

## 5. Layout & UX — Single-Screen Design (TRANSLATE_DUB)

Mục tiêu: **tất cả nội dung vừa trong 1 khung màn hình duy nhất**, không cần scroll trang.

### 5.1. Bố cục 2 Panel (Split-Panel Layout)

```
┌─────────────────────────────────────────────────────────────────┐
│ Breadcrumb: ← Quay lại dự án                                    │
├─────────────────────────────────────────────────────────────────┤
│ Header: [Title] [Status] [Xoá] [Chạy lại] [Xem video] [Tải]   │
├─────────────────────────────────────────────────────────────────┤
│ InfoBar (compact 1 dòng): Mode | Lang | Style | Dubbing | Mask │
├───────────────────────────────────────┬─────────────────────────┤
│                                       │                         │
│   VIDEO PLAYER + SubRegionEditor      │  Pipeline Progress      │
│   (chiếm ~65% chiều rộng)             │  (compact, horizontal)  │
│                                       │                         │
│   - Video player lớn                   ├─────────────────────────┤
│   - Overlay mask regions              │                         │
│   - Mask controls (toolbar)           │  TRANSCRIPT EDITOR      │
│                                       │  (scrollable panel)     │
│                                       │                         │
├───────────────────────────────────────┴─────────────────────────┤
│  TIMELINE BAR (horizontal, full-width)                          │
│  [◄] [▶/❚❚] [►] [====•====================] [00:45 / 03:20]   │
│  [Segment markers] [Current segment info]                       │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2. TimelineBar Component (Mới)

Thanh timeline full-width ở bottom, bao gồm:

**Playback Controls:**
- Play/Pause button
- Skip backward/forward ±5s
- Playback speed selector (0.5x, 1x, 1.5x, 2x)
- Volume control

**Scrubber Bar:**
- Thanh kéo chính hiển thị progress
- Timestamp hiện tại / tổng thời lượng
- Hover tooltip hiển thị thời gian tại vị trí con trỏ

**Segment Track:**
- Mỗi câu transcript là 1 segment marker trên timeline
- Hiển thị text gốc (hoặc bản dịch) trên segment
- Click segment → jump đến câu đó trong transcript
- Color-code theo speaker (nếu có diarization)
- Drag mép trái/phải của segment block để điều chỉnh startSec/endSec (drag-to-resize)
- Ghost preview hiển thị thời gian mới khi đang kéo
- Double-click segment để mở inline timing editor

**Zoom Controls:**
- +/- button để phóng to/thu nhỏ timeline
- Fit all segments / Fit current segment

**Keyboard Shortcuts:**
- Space: Play/Pause
- ←/→: Seek ±5s
- ↑/↓: Navigate segments
- +/-: Zoom timeline

### 5.3. TranscriptView + SubRegionEditor

**Panel Trái (Video + Mask):**
- Video player lớn, chiếm không gian tối đa
- SubRegionEditor overlay trên video (compact mode)
- Toolbar mask (Thêm/Gộp/Xoá vùng) compact
- Region controls hiển thị khi chọn region

**Panel Phải (Pipeline + Transcript):**
- Pipeline Progress: Hiển thị compact dạng badges/horizontal stepper
**TRANSLATE_DUB — Hybrid Subtitle Editor:**

**Danh sách song ngữ:**
- Hiển thị text gốc ↔ translation, kèm badge speaker
- Highlight segment đang active (tương ứng với thời gian video hiện tại)

**Điều chỉnh thời gian (Timing Control):**
- Mỗi segment có input số cho phép nhập chính xác `startSec` và `endSec` (định dạng `HH:MM:SS.mmm`)
- Badge hiển thị nếu segment đã được chỉnh sửa thủ công (`isTimeManuallyAdjusted`)
- Nút "Reset to AI" để hoàn nguyên thời gian tự động

**Cảnh báo trực quan (Visual Warnings):**
- Nếu `CPS > 25` ký tự/giây: hiển thị icon cảnh báo màu vàng với tooltip "Reading too fast"
- Nếu `CPS > 35` ký tự/giây: hiển thị icon màu đỏ với tooltip "Unreadable speed"
- Nếu 2 segment bị chồng lấn thời gian: hiển thị viền đỏ cả 2 segment

**Đồng bộ Player:**
- Click vào segment → player seek đến `startSec` và highlight segment đó
- Kéo thanh timeline → segment đang hiển thị được auto-select

### 5.4. TimelinePreview (SUMMARY Mode — không thay đổi)

- TimelineClip[] dạng track ngang
- Mỗi clip: thumbnail, thời lượng, transition icon
- Player đồng bộ: click clip → nhảy đến `startAtSec`
- **Chỉ xem**, không edit

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
