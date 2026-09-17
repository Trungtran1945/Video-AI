# 04 — Thiết kế Frontend (Dashboard)

> **Lưu ý Triển khai:** Thiết kế target dùng React 19 + TypeScript + `apps/web/`.
> Triển khai hiện tại dùng React 18 + JavaScript (JSX) + `frontend/`.

Frontend (`apps/web`) là **React 19 + Vite + TypeScript** (target), giao diện SaaS hiện đại, tối (dark mode),
thẻ bo góc, accent xanh, animation mượt (Framer Motion), responsive & mobile-friendly.

---

## 1. Công nghệ & nguyên tắc

- **TanStack Query** — fetch/cache API, polling tiến trình queue.
- **React Router** — routing trang.
- **React Hook Form + Zod** [TARGET/FUTURE] — form & validate (schema chia sẻ từ `packages/shared`).
  [CURRENT] Wizard `CreateProject` dùng local state (`useState`), không RHF/Zod theo từng bước
  (RHF chỉ tồn tại trong `components/ui/form.jsx` của shadcn, wizard không dùng).
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

> [CURRENT] Triển khai hiện tại: `frontend/` (React `^18.2.0` JS/JSX, không React 19 + TS),
> typecheck qua `tsc -p ./jsconfig.json` (`frontend/package.json:10-11`, không `tsconfig.json`).
> Routes (`frontend/src/App.jsx:58-78`): public `/`, `/login`, `/register`, `/forgot-password`,
> `/reset-password`, `/timeline` (demo); protected `/dashboard`, `/projects`, `/projects/new`,
> `/projects/:id`, `/queue`, `/outputs`, `/analytics`, `/settings`, `/settings/providers`,
> `/settings/api-keys`, `/logs`, `/admin`.

---

## 3. Trang chính

| Trang | Mô tả |
| --- | --- |
| Landing | Giới thiệu 2 mode, CTA đăng ký |
| Login / Register | Auth ([TARGET/FUTURE] RHF + Zod; CURRENT: form thường, không RHF trong `pages/`) |
| Dashboard | Widget: video đã sinh, queue, storage, provider status, lịch sử |
| Projects | Danh sách project (filter theo mode), trạng thái |
| ProjectDetail | [CURRENT] Pipeline stage (SSE `useJobEvents` + fallback polling), transcript song ngữ chỉnh sửa được + banner `outputStale`, nút Huỷ / Chạy lại / Lồng tiếng lại, `VideoTimeline` ở cuối, output (SUMMARY: preview read-only, xem §5.4) |
| CreateProject | **Wizard** (dưới) |
| Queue | Bảng job đang chạy/thất bại, retry thủ công |
| Outputs | Thư viện video, download, đẩy YouTube |
| Settings / ProviderSettings / ApiKeys | Cấu hình user & provider; **ApiKeys** hỗ trợ khai báo nhiều key/1 provider (label + priority) cho round-robin khi dùng free tier, hiển thị mức dùng RPM/RPD hiện tại theo từng key (`11` §5) |
| Logs | Bảng ProviderLog (cost, token, status) |
| Analytics | Biểu đồ theo thời gian |
| Admin | Quản lý user, provider global, hệ thống |

---

## 4. Project Creation Wizard

Wizard 2 mode khác nhau:

### Mode `SUMMARY` (Review phim) [CURRENT — `frontend/src/pages/CreateProject.jsx`]

Wizard local state (`useState`, không RHF/Zod), 6 bước:

1. **Chọn mode** = SUMMARY.
2. **Phim**: upload phim (2–3h).
3. **Ngôn ngữ**: chọn `language`.
4. **Độ dài**: `targetDurationSec` (20/25/30 phút).
5. **Phong cách**: `style` + `tone` + `spoilerAllowed`.
6. **Giọng đọc**: `voiceProvider` + `voiceName` (tuỳ chọn).
7. **Tạo video**: checkbox bản quyền bắt buộc (`copyrightAcknowledged`, không tick thì nút
   "Bắt đầu tạo" bị disable — xem `00` §5, `03` §5) + `FreeTierWarning` (SUMMARY > 60 phút) +
   tên dự án (tuỳ chọn) → `POST /projects` payload
   `{mode, title, language, style, targetDurationSec, sourceVideoKey, videoHash,
   copyrightAcknowledged, params: {tone, spoilerAllowed, voiceProvider, voiceName}}`.

### Mode `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng) [CURRENT — `frontend/src/pages/CreateProject.jsx`]

Wizard local state (`useState`, không RHF/Zod), 5 bước:

1. **Video**: upload video (tối đa 2GB) — resumable, hiện % chunk đã nhận; rớt mạng resume không mất.
2. **Ngôn ngữ**: nguồn (`sourceLanguage`, `auto` hoặc chọn) → đích (`targetLanguage`, mặc định `vi`);
   toggle **OCR phụ đề cứng** (`ocrMode`; bật OCR thì nguồn không được để `auto`).
3. **Biên dịch**: chọn 1 trong 13 StylePreset (`stylePreset`, card có mô tả; load qua
   `GET /style-presets`, fallback hằng số local khi API lỗi).
4. **Lồng tiếng AI** (toggle `enableDubbing`): bật → chọn `voiceProvider` + `voiceName` (tuỳ chọn);
   tắt → giữ audio gốc, chỉ thay phụ đề. `subPosition` cố định `'original'`.
5. **Tạo video**: checkbox bản quyền bắt buộc (tương tự SUMMARY) + `FreeTierWarning`
   (TRANSLATE_DUB > 20 phút) + tên dự án (tuỳ chọn) → `POST /projects` payload
   `{mode: 'TRANSLATE_DUB', title, sourceLanguage, targetLanguage, stylePreset, enableDubbing,
   subPosition: 'original', sourceVideoKey, videoHash, ocrMode, copyrightAcknowledged,
   params: {voiceProvider?, voiceName?, subPosition}}` — [CURRENT] không có `maskMethod` /
   `voiceId` / `maskStrength` trong payload.

> [NOT IMPLEMENTED] Bước "Nâng cao" (chọn `maskMethod` `blur`/`fill`/`inpaint`, vị trí phụ đề
> `Top`/`Bottom`/`Custom`, thanh kéo `maskStrength`) chưa có trong wizard hiện tại.

> [NOT IMPLEMENTED] Bước **"Xem trước & Xác nhận"** (FR-J2): API orphan — wrapper FE
> `confirmPreview` (`frontend/src/api/projects.js:21`,
> `POST /projects/:id/translate-dub/confirm-preview`) có nhưng `ProjectDetail` không gọi;
> không có nút "Render bản cuối" enqueue riêng `dub.ttsAlign`/`dub.render`.

Wizard dùng local state machine đơn giản (`step` + `useState` mỗi bước); [TARGET/FUTURE] `useWizard` +
RHF mỗi bước + validate Zod trước khi next.

---

## 4.1. SubRegionEditor (riêng TRANSLATE_DUB) [NOT IMPLEMENTED]

> [NOT IMPLEMENTED] Không có editor Canvas khoanh vùng hardsub trong code hiện tại
> (`ProjectDetail` TRANSLATE_DUB không render overlay mask; không có thanh kéo `maskStrength`,
> tick `isStatic`, nút Merge Regions hay gợi ý vị trí phụ đề). Toàn bộ mục này là [TARGET/FUTURE].

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

## 4.2. Tiến trình real-time (SSE) [CURRENT — `useJobEvents` + `ProjectDetail`]

- Hook `useJobEvents(projectId)` (`frontend/src/hooks/useJobEvents.js`) mở **EventSource** tới
  `GET /projects/:id/events`. Mỗi event `{ stage, status, percent }` cập nhật stepper pipeline +
  progress bar không cần F5. Nếu SSE lỗi (backend chưa hỗ trợ/không parse được) → `sseAvailable=false`
  và caller **fallback polling** `GET /projects/:id/jobs` mỗi 3s (`POLL_INTERVAL_MS`), chỉ poll khi
  project còn active và SSE không khả dụng.
- Stages [CURRENT]: SUMMARY 8 stage (`summary.transcribe → … → summary.render`); TRANSLATE_DUB
  (`dub.ingest → dub.stt → dub.translate → dub.ttsAlign? → dub.render`, `ttsAlign` chỉ khi bật
  dubbing). [TARGET/FUTURE] Nhánh OCR song song (`dub.ocr`) chưa có trong code.
- Nút **"Huỷ"** ở header (`canCancel` khi status `running`/`queued`/`pending`) gọi
  `POST /projects/:id/cancel` (FR-J1); sau huỷ reload project, status `cancelled` (không `failed`).
- Nút **"Chạy lại"** (`completed`/`failed`) gọi `POST /projects/:id/regenerate`; nút
  **"Lồng tiếng lại"** gọi `POST /projects/:id/translate-dub/redub` (dùng bản dịch đã sửa tay).
- Sửa transcript (`PUT /projects/:id/transcript`, chỉ gửi segment đã đổi) trả `outputStale=true`
  → banner vàng "Video hiện tại chưa phản ánh bản chỉnh sửa — nhấn Lồng tiếng lại để cập nhật";
  banner tắt sau khi redub xong có output mới.
- Vì pipeline có thể chạy 20–30 phút (SUMMARY), dashboard hiển thị banner nhắc user có thể đóng tab —
  hệ thống sẽ gửi email/thông báo khi xong (FR-J3), không bắt buộc giữ SSE mở.
- Khi `GenerationJob.result.warnings` chứa cảnh báo `quota_risk` (xem `11` §4.1), stepper hiển thị
  icon vàng "Sắp chạm giới hạn API — có thể chậm hơn dự kiến" thay vì để user chờ mà không rõ lý do.
  Khi job chuyển `RETRY` do rate-limit, hiển thị **"Đang chờ quota provider hồi phục lúc HH:mm"**
  (không phải icon lỗi đỏ) để tránh hiểu nhầm hệ thống bị hỏng.

---

## 5. Layout & UX — Single-Screen Design (TRANSLATE_DUB)

Mục tiêu: **tất cả nội dung vừa trong 1 khung màn hình duy nhất**, không cần scroll trang.

### 5.1. Bố cục 2 Panel (Split-Panel Layout) [CURRENT]

> [CURRENT] TRANSLATE_DUB: panel trái (58%) là **Transcript Editor**, panel phải (42%) là
> **Video Preview** — không có `SubRegionEditor`/mask controls trong code. Sơ đồ target cũ
> (Video + SubRegionEditor trái, Pipeline + Transcript phải) là [TARGET/FUTURE].

```
┌─────────────────────────────────────────────────────────────────┐
│ Breadcrumb: ← Quay lại dự án                                    │
├─────────────────────────────────────────────────────────────────┤
│ Header: [Title] [Status] [Huỷ] [Xoá] [Chạy lại] [Xem] [Tải]      │
├─────────────────────────────────────────────────────────────────┤
│ Pipeline Progress (full-width, compact badges + progress bar)   │
├───────────────────────────────────────┬─────────────────────────┤
│                                       │                         │
│   TRANSCRIPT EDITOR (song ngữ,        │  VIDEO PREVIEW          │
│   chiếm ~58% chiều rộng)              │  (~42%)                 │
│                                       │                         │
│   - Danh sách segment gốc ↔ dịch      │  - Video output         │
│   - Sửa translation (textarea)        │  - Play/pause overlay   │
│   - Lưu / Lồng tiếng lại              │  - Info bar (time/mode) │
│   - Banner outputStale                │                         │
│                                       │                         │
├───────────────────────────────────────┴─────────────────────────┤
│  VIDEOTIMELINE (subtitle-sync review, full-width, xem §5.2)      │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2. VideoTimeline — Subtitle-Sync Review Timeline [CURRENT]

Thanh timeline full-width ở bottom của `ProjectDetail` (TRANSLATE_DUB) là timeline rà soát
đồng bộ phụ đề (`frontend/src/components/timeline/`) — [NOT IMPLEMENTED] không phải full video
editor (không Split/Speed/Volume/Delete clip, không thêm/xoá/lock/mute track trong code).

**Kiến trúc component [CURRENT]:**

| Component | Vai trò |
| --- | --- |
| `VideoTimeline` | Container chính: header controls, thân timeline cuộn ngang, footer, resize handle |
| `TrackSidebar` | Sidebar trái cố định (hiển thị track; chưa có lock/mute/delete) |
| `TimeRuler` | Thước thời gian sticky, tick thay đổi theo zoom, click/scrub để seek |
| `Playhead` | Đường playhead đỏ + handle kéo, guide line trắng "SNAP" khi magnetic snapping |
| `TimelineClip` | Một clip trên track: render theo type, drag-to-move, trim trái/phải |
| `FloatingToolbar` | [CURRENT] Chỉ hiển thị time range của clip đang chọn (không có nút thao tác) |
| `timelineStore` | Zustand store: state + actions (dưới) |
| `timelineUtils` | Hàm thuần: format timecode, magnetic snap, handle snap (trim) |

**State & actions (`useTimelineStore` — Zustand) [CURRENT]:**

- **Core:** `currentTime` (giây), `zoomLevel` (px/giây, mặc định 50, clamp 15–200), `tracks[]`,
  `clips[]`, `selectedClipId`.
- **Playback & snapping:** `isPlaying`, `snappingGuide`, `snappingEnabled` (mặc định true).
- **Actions:** `setCurrentTime`, `setZoomLevel`, `setSelectedClipId`, `setSnappingGuide`,
  `setSnappingEnabled`, `toggleSnapping`, `togglePlayPause`, `setIsPlaying`, `setClips`,
  `setTracks`, `initTimeline`, `updateClip`, `deleteClip`.
- [TARGET/FUTURE] `splitClip`, `addTrack`, `toggleTrackLock/Mute`, `deleteTrack`,
  `autoSnapEdges`, `snapEdgesForTrack` chưa có trong store.

**3 track mặc định [CURRENT] (`timelineStore.js:4-26`):** `video` (Video, locked) ·
`original` (Gốc, locked) · `translated` (Dịch) — không phải Video · Audio · Text.

**Sinh dữ liệu từ transcript & video thật (zero mock) [CURRENT]:**
- Khi `ProjectDetail` truyền `outputUrl`/`duration`, một clip **video track** đại diện toàn bộ
  output (`clip-video-main`, 0 → duration).
- Khi truyền `transcript[]`, mỗi segment trở thành **2 clip read-only** (timing từ transcript):
  một trên track Original + một trên track Translated (`segmentId` + `speaker`).
- [PARTIAL] Kéo một dòng segment từ Transcript panel đặt `dataTransfer`
  `application/x-transcript-segment` (drag source có), nhưng chưa có drop target nào trong
  `VideoTimeline` tiêu thụ để tạo clip — thả vào timeline hiện không tạo clip mới.

**Các thao tác clip [CURRENT]:**

- **Drag-to-move:** kéo clip dọc track; khi `snappingEnabled` bật, dùng `getMagneticSnap` chụp về
  các điểm snap trong ngưỡng **10px**.
- **Trim:** kéo handle trái/phải (`getHandleSnap` — snap tương tự).
- [TARGET/FUTURE] Split tại playhead, toolbar Speed/Volume/Delete, phím `S`/`Delete`.

**Zoom [CURRENT]:** nút ± (`setZoomLevel` ±10), hiển thị `%` so với mặc định 50px/s; ruler đổi mật
độ tick theo zoom.

**Playback & đồng bộ player:**
- `ProjectDetail` dùng chế độ **controlled**: truyền `currentTime`/`isPlaying` từ player; khi video
  phát, `VideoTimeline` đồng bộ playhead bằng `requestAnimationFrame` đọc `video.currentTime`
  (bỏ qua throttle của `timeupdate`).
- Chế độ uncontrolled (demo page `/timeline`): vòng lặp RAF nội bộ, tự quay đầu khi hết clip.
- Click clip có `segmentId` → gọi `onSegmentClick` (seek transcript); `activeSegmentId` highlight
  clip đang phát bằng viền vàng.

**Keyboard Shortcuts [CURRENT]:** `Space` Play/Pause · `←/→` scrub playhead.
[TARGET/FUTURE] `S` Split, `Delete`/`Backspace` Delete selected.

**Khác [CURRENT]:** chia lại chiều cao timeline bằng thanh kéo ngang phía dưới, lưu vào `localStorage`
(`timeline-height`, clamp 120–400); footer hiển thị gợi ý phím tắt.

### 5.3. TranscriptView [CURRENT — `ProjectDetail.jsx:932+`]

> [NOT IMPLEMENTED] Không có `SubRegionEditor` overlay, input sửa `startSec`/`endSec` từng segment,
> badge `isTimeManuallyAdjusted`, nút "Reset to AI", hay cảnh báo CPS/overlap trong code. Toàn bộ các
> ý dưới đây ngoài danh sách CURRENT là [TARGET/FUTURE].

**TRANSLATE_DUB — Subtitle Editor [CURRENT]:**

**Danh sách song ngữ:**
- Hiển thị text gốc ↔ translation (textarea sửa được), kèm badge speaker, timestamp `startSec → endSec`.
- Highlight segment đang active (tương ứng với thời gian video hiện tại); đếm đã dịch `x/y câu`.

**Lưu & lồng tiếng lại:**
- Nút "Lưu chỉnh sửa" gửi `PUT /projects/:id/transcript` chỉ với segment đã đổi → banner
  `outputStale` khi output cũ; nút "Lồng tiếng lại" (`POST …/translate-dub/redub`) render lại
  từ bản dịch đã sửa. Vô hiệu hoá khi pipeline đang chạy.

**Đồng bộ Player:**
- Click timestamp segment → player seek đến `startSec`; kéo playhead video → auto-select segment.
- Chọn ngôn ngữ đích (`vi`/`en`/`ja`/`ko`/`zh`) hiển thị phía trên editor.
- Kéo segment đặt `application/x-transcript-segment` (xem §5.2 — drop chưa được tiêu thụ).

### 5.4. TimelinePreview (SUMMARY Mode — read-only)

`VideoTimeline` editor ở trên dành riêng cho **TRANSLATE_DUB**. Với **SUMMARY**, layout giữ nguyên
một thanh preview **chỉ xem** (khác bản chất, không dùng chung `VideoTimeline`):

- `TimelineClip[]` dạng track ngang (mỗi clip: thumbnail, thời lượng, transition icon).
- Player đồng bộ: click clip → nhảy đến `startAtSec`.
- **Chỉ xem**, không edit — phù hợp nguyên tắc tự động hoá (tạo xong là xem), vẫn cho Regenerate.

---

## 6. Widget Dashboard

- `StatCard` — tổng video đã sinh, tổng phút video đã Việt hoá.
- `QueueStatus` — số job running/failed (polling `/queue`).
- `StorageUsage` — dung lượng theo `storage/`.
- `ProviderStatus` — health từ `/providers`.
- `GenerationHistory` / `RecentOutputs` — danh sách mới nhất.

---

## 7. Giao tiếp API & type-safety

> [TARGET/FUTURE] Type `z.infer` đồng bộ web & api qua `packages/shared` chưa có. [CURRENT] FE gọi
> REST qua axios client (`frontend/src/api/client.js` + các module `projects`/`upload`/`auth`/
> `outputs`/`extra.js`), không có schema/type chia sẻ — payload wizard ghi tay theo §4.

```ts
// [TARGET] apps/web/src/api/projects.ts
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
| TimelinePreview read-only (SUMMARY) | đúng yêu cầu tự động; vẫn cho Regenerate |
| `VideoTimeline` subtitle-sync review (TRANSLATE_DUB) | User rà soát transcript ↔ clip song song; store Zustand gọn, zero mock, đồng bộ player qua RAF (không phải full editor — Split/track-ops là TARGET) |
| Schema share từ packages/shared | [TARGET/FUTURE] type-safety đầu-cuối; CURRENT payload ghi tay, không schema chia sẻ |
| Checkbox bản quyền bắt buộc trong wizard | Ép user xác nhận trước khi hệ thống xử lý nội dung có thể có bản quyền (NFR-14) |
| Bước "Xem trước & Xác nhận" trước render cuối (TRANSLATE_DUB) | [NOT IMPLEMENTED] API orphan — FE wrapper có, `ProjectDetail` không gọi (FR-J2) |
| Nút Huỷ pipeline + thông báo ngoài SSE | UX tốt hơn cho pipeline dài, tránh phải giữ tab mở (FR-J1, FR-J3) |
| Cảnh báo quota (`quota_risk`) hiển thị riêng biệt với lỗi thật | Free-tier user cần biết pipeline chậm vì giới hạn ngoài, không phải hệ thống lỗi (`11` §4) |
| ApiKeys page hỗ trợ nhiều key/1 provider | Cho phép user tự tăng thông lượng hiệu dụng khi chỉ có các key miễn phí (`11` §5) |
