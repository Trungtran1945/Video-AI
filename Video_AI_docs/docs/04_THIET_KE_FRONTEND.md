# 04 — Thiết kế Frontend (Dashboard)

> **Lưu ý Triển khai:** Thiết kế target hướng tới React 19 + TypeScript + `apps/web/`.
> Triển khai hiện tại dùng React 18 + JavaScript (JSX) trong thư mục `frontend/`.

Giao diện frontend là ứng dụng SPA hiện đại, sử dụng chủ đề tối (Dark Theme `#0F1117`), bố cục mạch lạc, tối ưu hóa cho trải nghiệm sản xuất video tự động và giám sát thời gian thực.

---

## 1. Công nghệ & Thư viện Chính

- **React 18 & Vite 6**: Tốc độ khởi động và HMR nhanh chóng, cấu hình proxy `/api` và `/storage` sang `http://localhost:3001`.
- **Tailwind CSS & shadcn/ui**: Thiết kế giao diện dựa trên Radix UI primitives.
- **TanStack Query v5**: Quản lý server state, bộ nhớ đệm và tự động làm mới dữ liệu.
- **Zustand**: Quản lý client state nhẹ nhàng cho thanh timeline (`timelineStore.js`).
- **Framer Motion**: Chuyển cảnh trang, chuyển bước wizard và hiệu ứng vi mô mượt mà.
- **Lucide React**: Hệ thống biểu tượng giao diện nhất quán.
- **HTML5 Canvas**: Vẽ vùng che phụ đề hardsub trong `MaskEditor.jsx`.

---

## 2. Cấu trúc Thư mục Thực tế (`frontend/src/`)

```
frontend/src/
├── api/                      # Axios client, auth, projects, upload, outputs, extra
├── components/
│   ├── composer/             # MediaLibrary, ComposerPreview, ClipInspector, OcrTranslateModal, TtsModal
│   ├── layout/               # Sidebar, Topbar, Shell layout
│   ├── timeline/             # VideoTimeline, Playhead, TimeRuler, TimelineClip, timelineUtils
│   ├── ui/                   # Các component shadcn/ui (Button, Dialog, Tabs, Card...)
│   ├── ErrorBoundary.jsx     # Bắt lỗi toàn cục giao diện
│   └── MaskEditor.jsx        # Canvas editor vẽ vùng che hardsub (DRAFT, APPROVED, DISABLED)
├── hooks/                    # useAuth, useJobEvents (SSE realtime listener), custom queries
├── lib/                      # constants.jsx (STATUS_LABELS, STAGE_LABELS, MODE_LABELS), utils.js
├── pages/
│   ├── Admin.jsx             # Quản lý người dùng, queue metrics, cleanup tasks
│   ├── Analytics.jsx         # Thống kê sản lượng video, thời lượng, nhà cung cấp
│   ├── ApiKeys.jsx           # Quản lý API key theo từng provider, cảnh báo quota
│   ├── CreateProject.jsx     # WIZARD TẠO DỰ ÁN (hỗ trợ 4 mode)
│   ├── Dashboard.jsx         # Tổng quan hệ thống, widget thống kê, dự án gần đây
│   ├── ForgotPassword.jsx / ResetPassword.jsx # Luồng khôi phục mật khẩu
│   ├── Landing.jsx           # Trang giới thiệu
│   ├── Login.jsx / Register.jsx # Đăng nhập, đăng ký
│   ├── Logs.jsx              # Nhật ký cuộc gọi ProviderLog
│   ├── Outputs.jsx           # Thư viện video thành phẩm, download, YouTube publish
│   ├── ProjectDetail.jsx     # CHI TIẾT DỰ ÁN (Media Composer Studio, SSE progress, editor, timeline, player)
│   ├── Projects.jsx          # Danh sách dự án (lọc theo mode & status)
│   ├── ProviderSettings.jsx  # Cấu hình provider mặc định
│   ├── Queue.jsx             # Giám sát hàng đợi job
│   ├── Settings.jsx          # Cài đặt tài khoản người dùng
│   └── TimelineDemo.jsx      # Trang demo timeline
├── App.jsx                   # Định tuyến Router & Router Guard
└── main.jsx                  # Điểm khởi chạy ứng dụng
```

---

## 3. Các Trang Chức năng Chính

| Trang | Đường dẫn | Mô tả chức năng |
| --- | --- | --- |
| **Landing** | `/` | Giới thiệu nền tảng, các chế độ sản xuất video và CTA đăng ký |
| **Login / Register** | `/login`, `/register` | Xác thực người dùng (JWT access token + HttpOnly refresh cookie) |
| **Dashboard** | `/dashboard` | Tổng hợp số liệu video, tiến độ hàng đợi, dung lượng lưu trữ, provider health |
| **Projects** | `/projects` | Danh sách dự án, lọc theo mode (`MEDIA_COMPOSER`, `TRANSLATE_DUB`, `SCRIPT_TO_VIDEO`, `SUMMARY`) |
| **CreateProject** | `/projects/new` | **Wizard 4 chế độ**: Biên tập Media Composer, Dịch thuật & Lồng tiếng, Tạo video từ kịch bản, Review phim |
| **ProjectDetail** | `/projects/:id` | **Trung tâm điều khiển dự án**: Media Composer Studio 4 pane, SSE realtime, sửa transcript, vẽ mask, duyệt kịch bản, chạy lại |
| **Outputs** | `/outputs` | Danh sách video thành phẩm, kiểm tra cờ `outputStale`, tải file, liên kết xuất bản YouTube |
| **Queue** | `/queue` | Bảng theo dõi các job đang chạy trong hàng đợi |
| **ApiKeys** | `/settings/api-keys` | Quản lý đa API key (Gemini, OpenAI, ElevenLabs...), thanh tiến độ Quota Free Tier |
| **Logs** | `/logs` | Bảng nhật ký chi tiết các cuộc gọi `ProviderLog` (model, tokens, cost, status) |
| **Analytics** | `/analytics` | Biểu đồ phân tích hiệu suất và sản lượng video |
| **Admin** | `/admin` | Quản trị người dùng, thông số hàng đợi Redis/BullMQ, outbox dọn dẹp ổ đĩa |

---

## 4. Wizard Tạo Dự án (`CreateProject.jsx`)

Wizard hỗ trợ chuyển đổi linh hoạt giữa **4 chế độ sản xuất**:

### 4.1. Mode `MEDIA_COMPOSER` (Flagship — Biên tập Video Đa phương tiện & Đa rãnh)
- **Tải lên tài nguyên ban đầu**: Cho phép chọn và tải lên nhiều hình ảnh cùng lúc (kéo thả), tệp âm thanh nhạc nền BGM hoặc audio thuyết minh.
- **Cấu hình tỷ lệ khung hình**: Chọn định dạng hiển thị `16:9` (video ngang YouTube) hoặc `9:16` (video dọc TikTok/Reels/Shorts).
- **Tuỳ chọn âm thanh**: Nhập prompt mô tả bài nhạc nền hoặc chọn giọng thuyết minh AI.
- **Tự động kích hoạt**: Dự án được tạo và đưa người dùng trực tiếp vào không gian làm việc chuyên nghiệp Media Composer Studio.

### 4.2. Mode `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng) — 5 bước
1. **Chọn video**: Tải lên video ngoại ngữ (≤ 2GB) bằng resumable upload chunk 8MB.
2. **Ngôn ngữ**: Chọn ngôn ngữ nguồn (`auto` hoặc cụ thể) và ngôn ngữ đích (`vi`).
3. **Biên dịch**: Chọn 1 trong **13 phong cách dịch** (`co-trang`, `bat-trend`, `review-phim`, `tinh-cam`, `tai-lieu`, `hai-huoc`, `chinh-luan`, `gaming`, `kinh-di`, `the-thao`, `cong-nghe`, `tre-em`, `sat-nghia`).
4. **Lồng tiếng AI**:
   - Tuỳ chọn bật/tắt lồng tiếng (`enableDubbing`).
   - Chọn chế độ âm thanh (`audioMode`): `DUB_MIX` (Lồng tiếng + nhạc nền gốc), `DUB_REPLACE` (Thay thế hoàn toàn), `ORIGINAL_ONLY` (Giữ tiếng gốc).
   - Chọn giọng lồng tiếng AI (Edge-TTS, ElevenLabs, ZeroTTS...).
5. **Tạo video**: Xác nhận bản quyền bắt buộc và bấm "Bắt đầu tạo".

### 4.3. Mode `SCRIPT_TO_VIDEO` (Tạo video từ kịch bản) — 3 bước
1. **Kịch bản**: Tải lên tệp văn bản `.txt` hoặc nhập/dán kịch bản trực tiếp vào textarea (tự động đếm số từ và số ký tự).
2. **Cấu hình video**: Chọn tỷ lệ khung hình (`16:9` ngang hoặc `9:16` dọc), chọn giọng đọc AI và phong cách thuyết minh.
3. **Tạo video**: Xác nhận bản quyền bắt buộc và kích hoạt pipeline.

### 4.4. Mode `SUMMARY` (Legacy — Review phim & Video tóm tắt) — 6 bước
1. **Chọn phim**: Tải lên tệp phim dài 2–3 tiếng (resumable upload kiểu TUS).
2. **Ngôn ngữ**: Chọn ngôn ngữ thuyết minh (`vi`, `en`...).
3. **Độ dài**: Đặt thời lượng video mục tiêu (20, 25, 30 phút).
4. **Phong cách**: Thiết lập thể loại review (`cinematic`, v.v.), giọng điệu (`tone`) và cho phép tiết lộ nội dung (`spoilerAllowed`).
5. **Giọng đọc**: Chọn nhà cung cấp TTS và giọng đọc phù hợp.
6. **Tạo video**: Bắt buộc tick chọn **Xác nhận bản quyền** (`copyrightAcknowledged`), cảnh báo FreeTierWarning và bấm "Bắt đầu tạo".

---

## 5. Màn hình Chi tiết Dự án (`ProjectDetail.jsx`)

Màn hình chi tiết là nơi tương tác chính giữa người dùng và dự án đang chạy:

### 5.1. Media Composer Studio (Không gian làm việc 4 Pane)
Đối với các dự án `MEDIA_COMPOSER`, `ProjectDetail.jsx` hiển thị không gian làm việc phòng dựng studio chuyên nghiệp:
1. **Media Library (`MediaLibrary.jsx`)**:
   - Danh sách tài nguyên đa phương tiện (ảnh, audio, bgm).
   - Tải lên kéo-thả nhiều file đồng thời qua `POST /projects/:id/assets`.
   - Reorder thứ tự assets qua kéo thả.
   - Thao tác nhanh cho từng asset: Mở modal OCR trích xuất chữ, Dịch thuật song ngữ, và Sinh giọng đọc TTS.
2. **Dual-Mode Player (`ComposerPreview.jsx`)**:
   - **Chế độ Preview Canvas**: Kết xuất trực quan tức thì các layer hình ảnh, phụ đề và audio thời gian thực theo vị trí đầu đọc playhead.
   - **Chế độ Video MP4 Output**: Tự động chuyển sang trình phát video hoàn chỉnh khi pipeline render xong.
3. **Clip Inspector (`ClipInspector.jsx`)**:
   - Bảng điều khiển thuộc tính chi tiết cho clip đang được chọn trên timeline.
   - Tuỳ chỉnh thời gian bắt đầu, thời lượng, hiệu ứng zoom, âm lượng, nội dung chữ và toạ độ hiển thị.
4. **Multi-Track Timeline 5 rãnh (`VideoTimeline.jsx`)**:
   - 5 rãnh chuyên biệt: `BACKGROUND`, `MAIN_VIDEO`, `OVERLAY`, `VOICE`, `BGM`.
   - Hỗ trợ cắt xén hai đầu (Dual-handle trimming) với snap-to-grid và zoom timeline.
   - Nút **"Tự động sắp xếp" (`Auto Arrange`)**: Tự động tính toán và xếp các clip ảnh/audio khớp thứ tự.
   - Nút **"Render Video"**: Lưu cấu trúc timeline và kích hoạt pipeline kết xuất video hoàn chỉnh.

### 5.2. Cập nhật tiến độ Thời gian thực (SSE EventBus)
- Sử dụng hook `useJobEvents` kết nối tới `GET /api/v1/projects/:id/events` thông qua vé dùng một lần an toàn (`POST /api/v1/projects/:id/sse-ticket`).
- Thanh tiến độ tổng quan (`__project__`) và trạng thái từng stage (`pending`, `running`, `completed`, `failed`, `retry`).
- Tự động chuyển sang cơ chế polling cơ sở dữ liệu nếu kết nối SSE bị gián đoạn.

### 5.3. Trình chỉnh sửa Phụ đề Song ngữ (Bilingual Transcript Editor)
- Áp dụng cho `TRANSLATE_DUB`: Hiển thị danh sách câu thoại song ngữ (câu gốc ↔ câu dịch).
- Người dùng có thể sửa trực tiếp từng câu dịch; bấm "Lưu chỉnh sửa" để gửi `PATCH /segments/:id/translation`.
- **Cơ chế phát hiện Output cũ (`outputStale`)**: Khi transcript hoặc mask thay đổi, hệ thống tăng `transcript_version`, hiển thị banner cảnh báo video output hiện tại đã cũ.
- **Nút "Lồng tiếng lại" (`Redub`)**: Chạy lại quy trình lồng tiếng từ bản dịch mới mà không cần chạy lại ASR STT tốn kém.

### 5.4. Trình vẽ Vùng Che Phụ đề Hardsub (`MaskEditor.jsx`)
- Tích hợp Canvas overlay trực tiếp trên trình phát video:
  - Cho phép người dùng kéo thả để tạo vùng che chữ hardsub (hình chữ nhật tỷ lệ scale-invariant `ratioX`, `ratioY`, `ratioW`, `ratioH`).
  - Lựa chọn kiểu che: Làm mờ (`blur`) với thanh trượt bán kính mờ hoặc Đổ màu nền (`solid`).
  - **Quản lý Lifecycle**: `DRAFT` (bản nháp, có thể sửa toạ độ), `APPROVED` (đã duyệt, bất biến, sẵn sàng đưa vào render), `DISABLED` (tạm tắt).
  - Khóa bảo vệ: Mask `APPROVED` không thể sửa toạ độ/thời gian (`MASK_APPROVED_IMMUTABLE`), muốn sửa phải chuyển về `DRAFT`.

### 5.5. Duyệt Kịch bản (Review Gate trong SCRIPT_TO_VIDEO)
- Khi dự án dừng lại tại `script_review_required = 1`, giao diện hiển thị bảng phân đoạn kịch bản (`script_segments`).
- Người dùng xem trước câu thoại thuyết minh, mô tả thị giác (visual prompt) của từng slide, chỉnh sửa nếu cần và bấm "Tiếp tục tạo video" để kích hoạt các stage tiếp theo.

### 5.6. Các thao tác điều khiển dự án (Actions)
- **Huỷ dự án (`Cancel`)**: Gọi `POST /projects/:id/cancel` để dừng pipeline an toàn.
- **Chạy lại (`Regenerate`)**: Menu chọn chạy lại toàn bộ hoặc chạy lại từ một công đoạn cụ thể (`fromStage`).
- **Tải về video (`Download`)**: Tải tệp video MP4 thành phẩm hoặc file phụ đề SRT/ASS.
