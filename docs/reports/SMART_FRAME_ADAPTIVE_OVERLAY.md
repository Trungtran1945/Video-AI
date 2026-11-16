# BÁO CÁO TRIỂN KHAI: SMART FRAME & ADAPTIVE OVERLAY SYSTEM

**Dự án:** Video_AI (Local: `D:\E\Video_AI`)  
**Ngày hoàn thành:** 16/11/2026  
**Chức năng:** Tùy chỉnh Khung hình Đa Tỉ lệ, Tự động Căn chỉnh Lớp phủ Thông minh & Bảo vệ Độ phân giải Nền  
**Đơn vị thực hiện:** AI Swarm (Tech Lead, Senior Full-stack, Video Processing Engineer, Frontend Architect, QA)  

---

## 1. CÁC CHỨC NĂNG ĐÃ TRIỂN KHAI

### A. Custom Frame Ratio & Resolution (Tùy chỉnh Khung hình & Độ phân giải)
- **Aspect Ratio Presets:** Hỗ trợ đầy đủ 8 thiết lập tỉ lệ:
  - `16:9` — Landscape (Ngang chuẩn YouTube / TV).
  - `9:16` — Portrait (Dọc chuẩn TikTok / Reels / YouTube Shorts).
  - `1:1` — Square (Vuông chuẩn Instagram / Facebook Post).
  - `4:3` — Standard (Cổ điển / TV truyền thống).
  - `3:4` — Portrait Standard (Khung dọc chuẩn ảnh).
  - `4:5` — Social Media (Chuẩn Instagram Feed Portrait).
  - `21:9` — Cinematic (Màn ảnh rộng điện ảnh).
  - `Custom` — Người dùng tự do nhập Chiều rộng (Width) và Chiều cao (Height).
- **Even Dimension Rule (H.264/YUV420P):** Toàn bộ kích thước khung hình (cả preset và custom) đều được chuẩn hóa qua thuật toán `toEven(v) = Math.max(2, Math.floor(v / 2) * 2)` nhằm bảo đảm tương thích tuyệt đối với bộ mã hóa H.264/AAC, ngăn ngừa lỗi `width not divisible by 2`.
- **Lock Aspect Ratio & Live Preview:** Cho phép bật/tắt khóa tỉ lệ khi thay đổi chiều rộng/cao, khung xem trước (Preview) tự động co giãn trực tiếp theo tỉ lệ mới mà không làm mất clip hay reset timeline.

### B. Smart Overlay Auto Fit (Tự động Căn chỉnh Lớp phủ Thông minh)
- **Cơ chế Mặc định (Default Behavior):**
  - Giữ nguyên tỉ lệ khung hình gốc của ảnh/video tư liệu (`lockAspect: true`).
  - Chế độ phủ mặc định: `CONTAIN` (Vừa khung hình).
  - Căn giữa mặc định (`align: 'center'`).
  - Không kéo giãn, không méo hình, không vượt quá kích thước frame canvas.
- **Bảng Điều khiển Clip Inspector:**
  - Bật/tắt `Auto Fit` (Tự động căn chỉnh).
  - Lựa chọn 3 chế độ: `CONTAIN` (Vừa khung), `COVER` (Lấp đầy), `FILL` (Kéo giãn toàn khung kèm cảnh báo biến dạng).
  - Thanh trượt Phóng to/Thu nhỏ (`Scale`: 10% – 300%).
  - Thanh trượt Tọa độ vị trí (`Pos X`, `Pos Y`: -50% đến +50%).
  - Lưới neo căn lề 9 điểm trực quan (`3x3 Alignment Grid`: Top-Left, Top-Center, Top-Right, Mid-Left, Center, Mid-Right, Bottom-Left, Bottom-Center, Bottom-Right).
  - Khóa tỉ lệ gốc (`Lock Aspect Ratio`).
  - Nút `Reset Transform` (khôi phục cài đặt gốc).
- **Hỗ trợ Nhiều Lớp phủ Đồng thời (Multiple Overlays):**
  - Hỗ trợ render đồng thời nhiều ảnh/video overlay trên các track khác nhau (PIP, watermark, logo, hiệu ứng).
  - Từng overlay được tính toán độc lập, không làm thay đổi các overlay khác.

### C. Background Resolution Protection (Bảo vệ Độ phân giải Nền)
- **Trích xuất Metadata Nguồn bằng FFprobe:**
  - Tự động trích xuất chính xác: `width`, `height`, `aspectRatio`, `fps`, `codec`, `pixFmt`.
- **Chế độ Phủ Nền SMART:**
  - Thiết lập ngưỡng phóng đại tối đa tập trung: `MAX_UPSCALE = 2.0`.
  - Khi tư liệu nền có độ phân giải thấp hơn nhiều so với khung hình xuất (ví dụ nguồn 640x360 xuất ra 1920x1080), chế độ `SMART` sẽ giới hạn upscale ở mức an toàn (không quá 2.0x) và bù phần còn lại bằng màu nền dự phòng (`defaultBackground`), ngăn ngừa hiện tượng vỡ hạt/mờ nhòe điểm ảnh.
  - Hiển thị huy hiệu **Cảnh báo Chất lượng Thấp (Quality Warning)** trên Clip Inspector khi ảnh/video có độ phân giải thấp.

---

## 2. DANH SÁCH FILE ĐÃ CHỈNH SỬA & TẠO MỚI

### Frontend:
1. `frontend/src/components/composer/FrameSettingsModal.jsx` (Mới): Modal cấu hình khung hình đa tỉ lệ, độ phân giải, framerate, màu nền canvas và xem trước trực quan.
2. `frontend/src/components/composer/index.js`: Xuất `FrameSettingsModal`.
3. `frontend/src/pages/ProjectDetail.jsx`: Tích hợp nút mở modal cấu hình khung hình trên Studio Toolbar, kết nối API cập nhật dự án.
4. `frontend/src/components/composer/ComposerPreview.jsx`: Container hiển thị co giãn động theo tỉ lệ frame; render đồng thời nhiều visual overlay; chuyển đổi công thức CSS transform đồng nhất với filtergraph FFmpeg.
5. `frontend/src/components/composer/ClipInspector.jsx`: Bổ sung toàn bộ bảng điều khiển Smart Overlay Controls (Auto Fit, Fit Modes, Scale, Offset X/Y, Lưới căn lề 9 điểm, Cảnh báo chất lượng).
6. `frontend/src/components/timeline/timelineUtils.js`: Tính toán frame timecode động theo `fps` của dự án.
7. `frontend/src/components/timeline/VideoTimeline.jsx`, `Playhead.jsx`, `TimeRuler.jsx`: Tiếp nhận và truyền tham số `fps` của dự án đến thước đo và kim thời gian.

### Backend:
1. `backend/src/pipeline/context.js`: Mở rộng `dimsForAspect` hỗ trợ `16:9, 9:16, 1:1, 4:3, 3:4, 4:5, 21:9, custom` và áp dụng `toEven()` trên mọi kích thước.
2. `backend/src/pipeline/stages/composerRender.js`: Xây dựng filtergraph FFmpeg cho Smart Overlay Auto Fit, căn tọa độ theo 9 điểm neo + offset, xử lý nhiều overlay song song, và bảo vệ độ phân giải nền qua `MAX_UPSCALE`.
3. `backend/src/pipeline/stages/composerPrepare.js`: Đồng bộ kích thước khung hình chuẩn hóa chẵn.
4. `backend/src/media/ffmpeg.js`: Mở rộng `probe()` trả về `pixFmt` và `aspectRatio`.
5. `backend/src/services/composerService.js`: Lưu trữ metadata media thăm dò được vào `assets.meta`.
6. `backend/src/routes/v1/composerAssets.js`: Format asset DTO trả về `width`, `height`, `aspectRatio`, `meta`.
7. `backend/src/routes/v1/projects.js`: Mở rộng `PATCH /api/v1/projects/:id` cho phép cập nhật `aspectRatio`, `resolution`, `params` với validation kích thước chẵn.
8. `backend/src/config.js`: Tập trung cấu hình `maxUpscale: 2.0`.

### Test Suites:
1. `backend/tests/smartFrameAdaptiveOverlay.test.mjs` (Mới): Kiểm thử toàn bộ 8 tỉ lệ, kích thước chẵn, persistence API, tính toán toán học Auto Fit và lưu trữ Clip Meta.
2. `backend/tests/composerSmartOverlayRender.test.mjs` (Mới): Kiểm thử kết xuất FFmpeg thực tế cho custom resolution, overlay transform/alignment, multi-overlay và background smart upscale.

---

## 3. THUẬT TOÁN AUTO FIT & TỌA ĐỘ LỚP PHỦ (MATHEMATICAL MODEL)

### Thuật toán Auto Fit:
```javascript
// Tính tỉ lệ co giãn cơ sở
let scale = 1.0;
if (fit === 'cover') {
  scale = Math.max(frameW / sourceW, frameH / sourceH);
} else if (fit === 'fill') {
  // Co giãn độc lập hai chiều (cảnh báo méo hình)
  targetW = frameW * clipScale;
  targetH = frameH * clipScale;
} else {
  // CONTAIN (Mặc định)
  scale = Math.min(frameW / sourceW, frameH / sourceH, maxScale || 3.0);
}

if (fit !== 'fill') {
  targetW = Math.max(2, Math.floor((sourceW * scale * clipScale) / 2) * 2);
  targetH = Math.max(2, Math.floor((sourceH * scale * clipScale) / 2) * 2);
}
```

### Thuật toán Điểm Neo 9 Vị Trí (9-Point Anchor Grid) & Offset:
Tọa độ gốc $(X_0, Y_0)$ được xác định dựa theo điểm neo:
- `center`: $X_0 = \frac{W - w}{2}$, $Y_0 = \frac{H - h}{2}$
- `top-left`: $X_0 = 0$, $Y_0 = 0$
- `top-center`: $X_0 = \frac{W - w}{2}$, $Y_0 = 0$
- `top-right`: $X_0 = W - w$, $Y_0 = 0$
- `center-left`: $X_0 = 0$, $Y_0 = \frac{H - h}{2}$
- `center-right`: $X_0 = W - w$, $Y_0 = \frac{H - h}{2}$
- `bottom-left`: $X_0 = 0$, $Y_0 = H - h$
- `bottom-center`: $X_0 = \frac{W - w}{2}$, $Y_0 = H - h$
- `bottom-right`: $X_0 = W - w$, $Y_0 = H - h$

Tọa độ thực tế:
$$\text{Final X} = X_0 + \text{round}(\text{posX} \times W)$$
$$\text{Final Y} = Y_0 + \text{round}(\text{posY} \times H)$$

*Công thức trên được áp dụng đồng nhất 100% giữa CSS Transform trong [ComposerPreview.jsx](file:///D:/E/Video_AI/frontend/src/components/composer/ComposerPreview.jsx) và câu lệnh `overlay=x:y` trong [composerRender.js](file:///D:/E/Video_AI/backend/src/pipeline/stages/composerRender.js).*

---

## 4. CƠ CHẾ BẢO VỆ ĐỘ PHÂN GIẢI NỀN (BACKGROUND PROTECTION)

Khi ảnh hoặc video nền có kích thước nhỏ hơn khung hình xuất:
1. Hệ thống tính tỉ lệ phóng đại: $S_W = \frac{\text{frameW}}{\text{sourceW}}$, $S_H = \frac{\text{frameH}}{\text{sourceH}}$.
2. Nếu $\max(S_W, S_H) > \text{MAX\_UPSCALE}$ ($2.0\times$):
   - Chế độ `SMART` sẽ chặn upscale ở mức $2.0\times$.
   - Canvas sẽ được đệm bằng màu nền dự phòng (`defaultBackground`), tránh hiện tượng điểm ảnh bị kéo giãn vỡ hạt.
3. Đồng thời, giao diện Clip Inspector hiển thị cảnh báo vàng khuyến nghị người dùng chọn chế độ Smart để bảo vệ chất lượng hiển thị.

---

## 5. KẾT QUẢ KIỂM THỬ

| Hạng mục kiểm thử | Công cụ / Lệnh | Kết quả | Ghi chú |
|---|---|---|---|
| **Smart Frame & Overlay Unit Tests** | `node backend/tests/smartFrameAdaptiveOverlay.test.mjs` | **PASS (100%)** | Xác minh 8 tỉ lệ, toEven, API PATCH, math CONTAIN/COVER |
| **FFmpeg Rendering Filtergraph Tests** | `node backend/tests/composerSmartOverlayRender.test.mjs` | **PASS (100%)** | Render MP4 thực tế custom 720p, 9-point align, multi-overlay, smart upscale |
| **Frontend Lint Gate** | `cd frontend && npm run lint` | **PASSED** | 0 errors, 0 warnings |
| **Frontend Typecheck** | `cd frontend && npm run typecheck` | **PASSED** | TypeScript/JSDoc clean (code 0) |
| **Frontend Production Build** | `cd frontend && npm run build` | **PASSED** | Vite build thành công (7.31s) |
| **Browser E2E Live Verification** | Playwright Chromium (`http://localhost:5173`) | **PASSED** | Xác minh FrameSettingsModal, chuyển 9:16 Shorts, kiểm tra Clip Inspector |

### Ảnh chụp bằng chứng kiểm thử trên Trình duyệt:
- `page-2026-11-16T07-25-13-623Z.png`: Màn hình giao diện FrameSettingsModal với đầy đủ 8 tỉ lệ khung hình, độ phân giải, framerate và bảng màu nền.
- `page-2026-11-16T07-25-40-967Z.png`: Màn hình Studio sau khi chuyển đổi sang khung hình dọc 9:16 (Shorts/TikTok), bảo toàn 100% dữ liệu timeline.
- `page-2026-11-16T07-27-26-289Z.png`: Màn hình Clip Inspector với toàn bộ các điều khiển Smart Overlay Controls (Auto Fit, 3 Fit Modes, Scale, Offset X/Y, Lưới căn lề 3x3, Lock Aspect, Reset).
