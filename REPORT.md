# BÁO CÁO TỔNG KẾT TOÀN DIỆN DỰ ÁN VIDEO_AI
## TÍNH NĂNG "CHẠY LẠI" (RESUME) CHO DỰ ÁN Ở TRẠNG THÁI "ĐANG CHỜ" (`QUEUED`) TIẾP TỤC TỪ BƯỚC MỚI NHẤT CỦA PIPELINE

> **Dự án:** Video_AI — Nền tảng biên dịch, lồng tiếng & sáng tạo video AI  
> **Yêu cầu người dùng:** *"Nếu dự án nào ở trạng thái Đang chờ thì hãy có nút Chạy lại cho phép dự án đó tiếp tục chạy ở bước mới nhất của pipeline"*  
> **Trạng thái thực thi:** **HOÀN THÀNH TOÀN DIỆN 100% (APPROVED)**  
> **Thời gian cập nhật:** 2026-10-28T18:59:00+07:00  
> **Phán quyết Code Review:** **`DECISION: APPROVED`**  
> **Chỉ thị vòng lặp:** **`CYCLE_STATUS: ALL_GOALS_COMPLETED`**  
> **Tài liệu tham chiếu:**  
> - Kế hoạch kỹ thuật: [.team/PLAN.md](file:///D:/E/Video_AI/.team/PLAN.md)  
> - Báo cáo thay đổi mã nguồn: [.team/CODE_CHANGES.md](file:///D:/E/Video_AI/.team/CODE_CHANGES.md)  
> - Biên bản kiểm định & phê duyệt: [.team/REVIEW.md](file:///D:/E/Video_AI/.team/REVIEW.md)  
> - Tài liệu đặc tả API: [06_API.md](file:///D:/E/Video_AI/Video_AI_docs/docs/06_API.md)  
> - Tài liệu thiết kế Frontend: [04_THIET_KE_FRONTEND.md](file:///D:/E/Video_AI/Video_AI_docs/docs/04_THIET_KE_FRONTEND.md)  
> - Quy chuẩn kiến trúc & vận hành: [AGENTS.md](file:///D:/E/Video_AI/AGENTS.md)  

---

## 1. TỔNG QUAN NÂNG CẤP & BẢN CHẤT KỸ THUẬT

### 1.1. Hiện trạng trước khi nâng cấp
- **Về mặt hiển thị:** Trạng thái `queued` trong hệ thống tương ứng với nhãn tiếng Việt **"Đang chờ"** trên giao diện người dùng (phân biệt với `pending` mang nhãn "Chờ xử lý").
- **Điểm nghẽn trên Frontend:** Trước đây, nút "Chạy lại" tại thanh công cụ tiêu đề dự án (`ProjectHeader.jsx`) chỉ hiển thị khi dự án ở trạng thái `completed` hoặc `failed`, đồng thời bị ẩn hoàn toàn nếu dự án thuộc danh sách trạng thái hoạt động (`ACTIVE_STATUSES = ['pending', 'queued', 'running']`). Ngoài ra, hàm xử lý bấm nút (`handleRegenerate`) cũng áp dụng điều kiện chặn sớm nếu dự án đang active.
- **Hệ quả:** Khi một dự án rơi vào trạng thái "Đang chờ" (ví dụ: do hàng đợi nền Redis chưa được bật hoặc do người dùng tạo nhiều dự án cùng lúc vượt quá giới hạn chạy đồng thời), người dùng không thể can thiệp kích hoạt thủ công trực tiếp từ giao diện web mà phải chờ đợi worker ngầm xử lý.

### 1.2. Giải pháp kỹ thuật tối ưu đã triển khai
1. **Khả dụng nút "Chạy lại" cho trạng thái "Đang chờ" (`queued`):**
   - Mở rộng điều kiện hiển thị nút `canRegenerate`: Cho phép hiển thị nút "Chạy lại" đối với cả 3 trạng thái: `completed`, `failed`, và `queued`.
   - Đối với các dự án tạo video từ kịch bản (`SCRIPT_TO_VIDEO`) đang tạm dừng để người dùng duyệt kịch bản (`status === 'queued'` và `scriptReviewRequired === true`), nút "Chạy lại" được ẩn có chủ đích để bảo toàn quy trình nghiệp vụ (người dùng sẽ sử dụng nút "Bắt đầu tạo video" sau khi duyệt).
2. **Tiếp tục thông minh từ bước chưa hoàn thành đầu tiên (`firstRunnableStage`):**
   - Tái sử dụng trọn vẹn endpoint `POST /api/v1/projects/:id/regenerate` hiện có. Khi không truyền tham số `fromStage`, backend tự động tính toán vị trí tiếp tục thông qua hàm chuẩn `firstRunnableStage(validStages, jobs)`.
   - Các bước đã chạy thành công trước đó (`success`) sẽ được giữ nguyên 100%, không bị chạy lại, tiết kiệm tối đa thời gian và chi phí token/quota AI của người dùng.
3. **Ẩn menu chọn Stage thủ công cho dự án `queued`:**
   - Với dự án "Đang chờ", điểm chạy bắt buộc phải tiếp nối tuần tự theo chuỗi phụ thuộc của pipeline. Do đó, nút "Chạy lại" hiển thị dưới dạng nút bấm đơn (tự động căn chỉnh bo góc `rounded-lg`), ẩn mũi tên xổ xuống (chevron) và menu chọn stage để tránh việc người dùng chọn nhảy cóc gây lỗi thiếu dữ liệu đầu vào.
4. **Hàng rào an toàn & trải nghiệm người dùng thân thiện (Safety Guards):**
   - **Xử lý giới hạn chạy song song (Concurrency Limit 429):** Nếu hệ thống đang hết slot thực thi (`MAX_CONCURRENT_PROJECTS_PER_USER`), backend trả về thông báo rõ ràng: *"Đã đạt giới hạn dự án chạy song song — dự án vẫn ở trạng thái Đang chờ và sẽ tự chạy khi có slot trống."* Frontend bắt mã lỗi này và hiển thị Toast thông báo lịch sự, không hiển thị banner đỏ báo lỗi gây hoang mang.
   - **Bảo vệ toàn vẹn dữ liệu (`ALREADY_COMPLETED` 409):** Nếu một dự án `queued` đã có tất cả các bước đạt `success`, hệ thống từ chối chạy lại và trả về 409 `ALREADY_COMPLETED` nhằm ngăn chặn nguy cơ xoá nhầm các artifact đã hoàn thành.
   - **Chống Race Condition & Double-Click:** Tận dụng cơ chế atomic update trong `acquireProjectRun()` và bộ khoá `activeRuns` trong bộ chạy pipeline; nếu người dùng double-click nhanh hoặc worker ngầm claim cùng lúc, chỉ có duy nhất 1 luồng được cấp quyền chạy, request thứ hai nhận thông báo "Pipeline đang chạy".

---

## 2. BẢNG CHI TIẾT CÁC THAY ĐỔI MÃ NGUỒN

| Thành phần | Đường dẫn tập tin | Nội dung can thiệp kỹ thuật | Đánh giá Karpathy |
|---|---|---|:---:|
| **Backend Routing & Guards** | `backend/src/routes/v1/projects.js` | Thêm biến cờ `resumingQueued`; bổ sung guard 409 `SCRIPT_REVIEW_REQUIRED` (bảo vệ bước duyệt kịch bản); guard 409 `ALREADY_COMPLETED` (chống xoá nhầm artifact); tinh chỉnh thông điệp 429 concurrency thành thông báo tiến trình thân thiện. | **Surgical (~15 lines)** |
| **Frontend Page Logic** | `frontend/src/pages/ProjectDetail.jsx` | Cập nhật `canRegenerate` cho phép `queued` (loại trừ `isReviewParked`); điều chỉnh guard `handleRegenerate`; phân nhánh Toast thành công ("Đang tiếp tục pipeline"); xử lý Toast êm đẹp cho mã 429 `LIMIT_001` và 409 `PIPELINE_RUNNING`. | **Surgical (~25 lines)** |
| **Frontend Header UI** | `frontend/src/components/project/ProjectHeader.jsx` | Thêm `stagePickerEnabled = project?.status !== 'queued'`; ẩn nút chevron dropdown khi đang chờ; tự động chuyển đổi class bo góc `rounded-l-lg` sang `rounded-lg`. | **Surgical (~10 lines)** |
| **Suite Kiểm thử Tự động** | `backend/tests/queuedResume.test.mjs` | Xây dựng bộ test route-level toàn diện kiểm thử 7 kịch bản: T1 (Review gate), T2 (All success), T3 (Retry cooldown), T4 (Concurrency limit), T5 (Đúng stage tiếp tục), T6 (Chống double-start), T7 (Quyền sở hữu 403). | **Tạo mới (100% PASS)** |
| **Tài liệu Kỹ thuật** | `Video_AI_docs/docs/06_API.md`<br>`Video_AI_docs/docs/04_THIET_KE_FRONTEND.md` | Cập nhật đặc tả endpoint `POST /projects/:id/regenerate` với các mã lỗi mới và ma trận hiển thị nút bấm trên giao diện người dùng. | **Đồng bộ chuẩn xác** |

---

## 3. BẢNG TỔNG HỢP QUALITY GATES HỆ THỐNG

Toàn bộ các cổng kiểm tra chất lượng của hệ thống đạt kết quả **100% PASS**:

| Cổng kiểm tra (Quality Gate) | Lệnh thực thi | Kết quả | Chi tiết thực nghiệm |
|---|---|---|---|
| **Queued Resume Suite** | `node backend/tests/queuedResume.test.mjs` | **PASS (100%)** | Toàn bộ 7 kịch bản kiểm thử T1–T7 đều đạt kết quả xanh tuyệt đối. |
| **Resume Order Regression** | `node backend/tests/resumeOrder.test.mjs` | **PASS (100%)** | Xác nhận thứ tự tiếp tục stage theo pipeline chuẩn mực, không nhảy cóc. |
| **Project Admission Regression** | `node backend/tests/projectAdmission.test.mjs` | **PASS (100%)** | Xác nhận 18/18 tiêu chí về slot-counting, giới hạn chạy đồng thời và atomic claim. |
| **Pipeline Retry Regression** | `node backend/tests/pipelineRetry.test.mjs` | **PASS (100%)** | Xác nhận toàn vẹn cơ chế retry có kiểm soát và phân loại lỗi. |
| **Backend Regression Suite** | `cd backend; npm test` | **PASS (100%)** | **158/158 test files ALL PASS**, 0 failure, bảo toàn 100% chức năng hồi quy toàn hệ thống. |
| **Backend Linter** | `cd backend; npm run lint` | **PASS (100%)** | `eslint src tests scripts --quiet` đạt 0 lỗi, 0 cảnh báo. |
| **Frontend Linter** | `cd frontend; npm run lint` | **PASS (100%)** | `eslint . --quiet` đạt 0 lỗi, 0 cảnh báo. |
| **Frontend Production Build** | `cd frontend; npm run build` | **PASS (100%)** | Vite v6.4.3 đóng gói thành công 2203 modules trong 4.72s. |

---

## 4. HƯỚNG DẪN TRẢI NGHIỆM VÀ SỬ DỤNG CHO NGƯỜI DÙNG

Kể từ phiên bản này, khi một dự án ở trạng thái **"Đang chờ"**, người dùng có thể kích hoạt chạy lại vô cùng thuận tiện:

1. **Truy cập dự án:**
   - Vào danh sách dự án tại trang **Dự án** (`/projects`) hoặc **Hàng đợi** (`/queue`).
   - Mở chi tiết bất kỳ dự án nào có huy hiệu màu vàng cam **"Đang chờ"** (`queued`).
2. **Kích hoạt "Chạy lại":**
   - Tại góc phải của thanh tiêu đề dự án, người dùng sẽ thấy ngay nút **"Chạy lại"** (đi kèm biểu tượng xoay `RotateCcw`).
   - Nút được hiển thị độc lập, gọn gàng và không có menu xổ xuống phức tạp.
   - Bấm vào nút **"Chạy lại"**:
     - *Nếu hệ thống còn slot trống:* Hệ thống lập tức chuyển trạng thái dự án sang `pending` $\rightarrow$ `running`, hiển thị Toast thông báo xanh: *"Đang tiếp tục pipeline — Đang chạy từ bước [Tên bước]..."*. Dự án sẽ chạy tiếp nối ngay từ bước còn dở dang (ví dụ: đã xong Dịch thuật thì sẽ chạy tiếp bước Lồng tiếng hoặc Render).
     - *Nếu hệ thống đang bận/đầy slot:* Hệ thống hiển thị Toast thông báo: *"Chưa có slot chạy — Dự án vẫn ở trạng thái Đang chờ và sẽ tự động chạy khi một dự án khác kết thúc."* Dự án giữ nguyên trạng thái an toàn, không sinh lỗi đỏ.
3. **Dự án tạo video từ kịch bản (`SCRIPT_TO_VIDEO`):**
   - Khi dự án dừng ở bước chờ duyệt kịch bản (đã phân tích xong các phân đoạn), giao diện sẽ ưu tiên hiển thị không gian làm việc duyệt kịch bản và nút nổi bật **"Bắt đầu tạo video"**. Nút "Chạy lại" sẽ được ẩn để đảm bảo người dùng kiểm tra kỹ nội dung trước khi render video.

---

## 5. KẾT LUẬN

Yêu cầu của người dùng về việc bổ sung nút **"Chạy lại"** cho các dự án ở trạng thái **"Đang chờ"** để tiếp tục chạy ở bước mới nhất của pipeline đã được phân tích chuẩn xác, thiết kế tối giản, lập trình phẫu thuật và kiểm thử hoàn hảo.

Hệ thống hoạt động mượt mà, đạt 100% Quality Gates và sẵn sàng phục vụ người dùng trong môi trường vận hành thực tế.
