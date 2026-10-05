# Báo Cáo Hoàn Thành Frontend — Đồng Bộ Docs & Codebase (2026-10-05)

**Vai trò:** Frontend Engineer  
**Tài liệu đối chiếu:** `.team/PLAN.md` (§3 Phần việc Frontend) & `.team/BACKEND_REPORT.md`

---

## 1. Tổng Quan & Mục Tiêu Đạt Được

1. **Khớp 100% với kiến trúc và routes của backend:**
   - Đã điều chỉnh logic gọi API, component, form và state cho khớp với hành vi thực tế của backend Node.js + Express (`server.js`, `src/routes/v1/*`).
   - Loại bỏ hoàn toàn các thông tin giả định sai lệch cũ (như PostgreSQL, MinIO/S3) và thay thế bằng telemetry thực từ backend (`/health`, `/ready`, SQLite persistence state, in-process BullMQ/Redis, Durable Cleanup Outbox).
   - Sửa lỗi contract ở các API glossary, outputs, analytics và provider monitoring.
2. **Đảm bảo tính trực quan, thẩm mỹ cao và toàn vẹn giao diện:**
   - Giữ vững Dark Theme chuẩn `#0F1117`, card bo góc, typography sắc nét, màu sắc trạng thái ngữ cảnh (emerald cho healthy/success, amber cho degraded/running/retry, rose cho error/failed).
   - Bổ sung các tính năng tương tác thực tế: đổi vai trò người dùng, thử lại tác vụ cleanup, tải lên YouTube, nhận diện từ phân biệt hoa thường trong glossary, gắn nhãn API key.
3. **Vượt qua toàn bộ các cổng kiểm tra (Quality Gates):**
   - `npm run lint`: **0 error, 0 warning**
   - `npm run typecheck`: **0 error**
   - `npm run build`: **PASS** (2200 modules transformed thành công)

---

## 2. Chi Tiết Các File Frontend Đã Cập Nhật (10 Files)

### 2.1. `frontend/vite.config.js`
- **Thay đổi:** Bổ sung cấu hình proxy chuyển tiếp cho `/health` và `/ready` trỏ tới `http://localhost:3001` (bên cạnh `/api` và `/storage`).
- **Lý do:** Cho phép frontend trong môi trường phát triển (dev server Vite) gọi trực tiếp endpoint kiểm tra sức khỏe liveness/readiness của backend mà không bị chặn CORS.

### 2.2. `frontend/src/api/extra.js`
- **Thay đổi:**
  - Mở rộng `adminApi` với 3 phương thức: `providers()`, `cleanupTasks(params)`, `retryCleanupTask(id)`.
  - Khởi tạo và export `systemApi` với 2 phương thức: `health()` và `ready()`.
- **Lý do:** Khớp với toàn bộ routes quản trị trong `backend/src/routes/v1/admin.js` và `backend/server.js`.

### 2.3. `frontend/src/pages/ProjectDetail.jsx`
- **Thay đổi:**
  - **Sửa bug `loadGlossary`:** Trước đây gọi `setGlossaryTerms(res?.terms || [])`, nhưng backend `listGlossary` trả về mảng trực tiếp `Array`, dẫn đến `res?.terms` luôn là `undefined` và danh sách thuật ngữ luôn trống. Đã chuẩn hoá: `setGlossaryTerms(Array.isArray(res) ? res : res?.terms || [])`.
  - **Hỗ trợ `caseSensitive`:** Bổ sung checkbox "Phân biệt hoa/thường" (`newTermCaseSensitive`) trong form thêm thuật ngữ, truyền `caseSensitive` tới `projectsApi.addGlossaryTerm`.
  - **Gắn nhãn nhận diện:** Hiển thị huy hiệu `Aa` cho các thuật ngữ có `case_sensitive = 1`.

### 2.4. `frontend/src/pages/Admin.jsx`
- **Thay đổi:**
  - **Sức khỏe hệ thống thực tế:** Xoá bỏ mock dữ liệu cũ (PostgreSQL, MinIO/S3); thay thế bằng dữ liệu thời gian thực từ `systemApi.health()`:
    - Trạng thái SQLite Persistence (`HEALTHY` / `DEGRADED` / `WRITE_BLOCKED`), số lỗi save liên tiếp, hàng đợi write.
    - Hàng đợi tiến trình BullMQ & Redis (phản ánh trung thực: in-process dev queue khi không có Redis).
    - Lưu trữ video cục bộ an toàn (`SafeMediaStatic` chống path traversal).
    - Hàng đợi dọn dẹp bền vững (Durable Cleanup Outbox).
  - **Quản lý phân quyền người dùng:** Cho phép Admin đổi vai trò (`user`, `admin`, `guest`) trực tiếp qua dropdown và gọi `adminApi.setRole(u.id, role)` kèm thông báo Toast.
  - **Quản lý tác vụ dọn dẹp (Cleanup Outbox):** Hiển thị bảng tác vụ dọn dẹp từ `adminApi.cleanupTasks()`, lọc theo trạng thái (`pending`, `failed`, `done`) và cung cấp nút "Thử lại" gọi `adminApi.retryCleanupTask(t.id)` cho các tác vụ lỗi.
  - **Nút "Làm mới":** Cho phép cập nhật toàn bộ trạng thái hệ thống ngay lập tức.

### 2.5. `frontend/src/pages/Analytics.jsx`
- **Thay đổi:**
  - Tích hợp `analyticsApi.get()` lấy dữ liệu thống kê tính sẵn từ SQL backend thay vì chỉ duyệt client-side.
  - Thêm thẻ StatCard "Thời lượng dịch" (`minutesTranslated` phút video đã xuất).
  - Bổ sung bảng phân bổ trực quan theo chế độ sản xuất: Review Phim (SUMMARY) và Dịch & Lồng Tiếng (TRANSLATE_DUB).
  - Hiển thị tỷ lệ gọi thành công theo từng nhà cung cấp AI (`successCalls / calls`).
  - Dự phòng an toàn (graceful fallback) nếu endpoint analytics trả về dữ liệu rỗng.

### 2.6. `frontend/src/pages/ProviderSettings.jsx`
- **Thay đổi:**
  - Gọi đồng thời `settingsApi.get()` và `providersApi.list()`.
  - Hiển thị trạng thái cấu hình khóa API (`Key OK`) cho từng provider.
  - Hiển thị tỷ lệ thành công của provider dựa trên provider_logs gần nhất.
  - Vô hiệu hóa và hiển thị nhãn "(Chưa hỗ trợ)" đối với các provider đang tắt hoặc chưa khả dụng (`available: false`).

### 2.7. `frontend/src/pages/ApiKeys.jsx`
- **Thay đổi:**
  - Thêm trường nhập "Tên gợi nhớ (Label)" trong form thêm khóa mới, giúp người dùng đặt tên định danh cho key (ví dụ: "Gemini Pro Chính", "OpenAI Backup") thay vì bị ép lấy tên category chung chung.

### 2.8. `frontend/src/pages/Outputs.jsx`
- **Thay đổi:**
  - Tích hợp gọi `outputsApi.list()`.
  - Hiển thị huy hiệu cảnh báo `Cần xuất lại` (`outputStale`) khi video thành phẩm bị lệch phiên bản do transcript vừa được chỉnh sửa thủ công.
  - Kích hoạt nút "Tải lên YouTube" gọi API `outputsApi.youtube(o.id, 'private')` kèm trạng thái loading và phản hồi Toast thân thiện.

### 2.9. `frontend/src/pages/Dashboard.jsx`
- **Thay đổi:**
  - Tách thanh tiến trình pipeline 14 bước gộp chung trước đây thành 2 sơ đồ rõ ràng, đúng chuẩn kiến trúc 2 chế độ độc lập:
    - **Review Phim (SUMMARY):** 8 bước tuần tự.
    - **Dịch & Lồng Tiếng (TRANSLATE_DUB):** 6 bước tuần tự.

### 2.10. `frontend/src/pages/Queue.jsx`
- **Thay đổi:**
  - Hiển thị tên dự án (`job.project_title`) kèm liên kết dẫn thẳng tới trang chi tiết dự án `/projects/:id`.
  - Thêm nút "Làm mới" dữ liệu hàng đợi.
  - Hiệu ứng loading khi người dùng bấm "Thử lại" một tác vụ lỗi.

---

## 3. Kết Quả Kiểm Tra (Verification Results)

| Lệnh Kiểm Tra | Trạng Thái | Ghi Chú |
|---|---|---|
| `cd frontend; npm run lint` | **PASS** | 0 error, 0 warning (đã dọn sạch mọi unused import) |
| `cd frontend; npm run typecheck` | **PASS** | `tsc -p ./jsconfig.json` không có lỗi cú pháp hay kiểu dữ liệu |
| `cd frontend; npm run build` | **PASS** | `vite build` tạo bundle production hoàn chỉnh (2200 modules transformed) |

---

## 4. Kết Luận
Toàn bộ yêu cầu của Frontend Engineer đã hoàn tất chính xác, đồng bộ hoàn hảo với backend và các ràng buộc kiến trúc của dự án Video_AI.
