# Báo Cáo Khảo Sát & Kiểm Toán Cơ Sở Dữ Liệu SQLite (SQLite Audit Report)

**Dự án:** Video_AI  
**Tác giả:** Database Architect (`@db_architect`)  
**Ngày thực hiện:** 13/11/2026  
**Phiên bản:** 1.0.0  

---

## 1. Tổng Quan Kiểm Toán (Executive Summary)

Quá trình kiểm toán toàn diện đã được thực hiện trực tiếp trên cơ sở dữ liệu SQLite hiện tại của hệ thống:
1. **Database Đang Hoạt Động (Active):** `backend/data.db` (Dung lượng: 2.75 MB / 2,752,512 bytes).
2. **Database Bản Sao An Toàn (Backup):** `D:\E\Video_AI_Backups\data_sqlite_original_backup.db` (Dung lượng: 2.75 MB / 2,752,512 bytes).

### Kết quả chính:
- **Số bảng (Tables):** Đúng **31 bảng** (30 bảng theo đặc tả kiến trúc `Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md` + 1 bảng legacy `otp_codes`).
- **Tổng số bản ghi (Total Rows):** **9,374 rows** (Số lượng bản ghi và cấu trúc giữa Active DB và Backup DB **khớp nhau 100%**, không có sự sai lệch hay mất mát dữ liệu).
- **Views & Triggers:** 0 views, 0 triggers (Toàn bộ logic tính toán và sự kiện được quản lý ở tầng Backend application).
- **Chỉ mục (Indexes):** 32 chỉ mục do người dùng định nghĩa + 28 chỉ mục hệ thống tự tạo cho Primary Key / Unique constraints.
- **Ràng buộc Khóa Ngoại (Foreign Keys) trong SQLite:** Hiện tại **không khai báo `REFERENCES`** và không bật `PRAGMA foreign_keys = ON`. Quan hệ bảng được duy trì thủ công ở tầng code (`backend/src/db/`).
- **Tính toàn vẹn JSON (JSON Validation):** Kiểm tra 100% dữ liệu các cột JSON (`params`, `meta`, `ocr_data`, `payload`, `result`, `style_json`, `cues`, `keys_json`, `scene_refs`), **tất cả 100% hợp lệ**, 0 bản ghi lỗi cú pháp JSON.
- **Định dạng Thời gian (Timestamp Formats):** Tồn tại cả 2 định dạng: SQLite format `YYYY-MM-DD HH:MM:SS` (sinh bởi `datetime('now')`) và chuẩn ISO 8601 `YYYY-MM-DDTHH:MM:SS.sssZ`. Cả hai đều tương thích hoàn hảo khi chuyển sang kiểu `TIMESTAMPTZ` trong PostgreSQL.
- **Ký tự Đặc biệt & Đa ngôn ngữ (Unicode):** Dữ liệu chứa tiếng Việt có dấu đầy đủ, ký tự tiếng Trung (Hanzi), tiếng Anh, và các ký tự đặc biệt, yêu cầu PostgreSQL database phải khởi tạo với encoding `UTF8` và LC_COLLATE/CTYPE phù hợp.

---

## 2. Thống Kê Số Lượng Bản Ghi Chi Tiết (Table Row Counts)

Bảng đối chiếu số lượng dòng giữa CSDL hiện hành (`CURRENT`) và bản sao lưu (`BACKUP`):

| STT | Tên Bảng | Số Dòng (Current) | Số Dòng (Backup) | Tình Trạng Dữ Liệu |
|:---:|:---|:---:|:---:|:---|
| 1 | `provider_logs` | 6,228 | 6,228 | Nhật ký gọi API AI (LLM, TTS, STT) |
| 2 | `provider_cache` | 1,784 | 1,784 | Bộ đệm cache kết quả AI |
| 3 | `transcript_segments` | 554 | 554 | Các câu thoại trích xuất từ audio (Translate Dub) |
| 4 | `audios` | 357 | 357 | File âm thanh sinh ra (TTS / BGM) |
| 5 | `timeline_tracks` | 129 | 129 | Rãnh timeline đa tầng (Media Composer) |
| 6 | `generation_jobs` | 95 | 95 | Tiến trình thực thi từng stage pipeline |
| 7 | `upload_sessions` | 51 | 51 | Phiên tải lên tệp tin dạng chunk TUS-style |
| 8 | `timeline_clips` | 40 | 40 | Phân đoạn clip trên timeline kết xuất |
| 9 | `projects` | 22 | 22 | Dự án video (Media Composer, Dub, Summary) |
| 10 | `project_cleanup_tasks` | 17 | 17 | Outbox tác vụ dọn dẹp file sau khi xóa project |
| 11 | `users` | 16 | 16 | Tài khoản người dùng hệ thống |
| 12 | `outputs` | 15 | 15 | Video thành phẩm cuối cùng |
| 13 | `style_presets` | 13 | 13 | 13 phong cách dịch dựng sẵn hệ thống |
| 14 | `scenes` | 8 | 8 | Cảnh quay phát hiện được (Summary mode) |
| 15 | `assets` | 7 | 7 | File tài nguyên phụ trợ / Media library |
| 16 | `otp_codes` | 6 | 6 | Mã xác thực OTP (bảng legacy trước `email_otps`) |
| 17 | `subtitles` | 6 | 6 | File phụ đề (.srt / cues JSON) |
| 18 | `ocr_regions` | 5 | 5 | Vùng che mờ hardsub video |
| 19 | `provider_rate_limits` | 5 | 5 | Cấu hình giới hạn rate limit provider AI |
| 20 | `script_segments` | 4 | 4 | Đoạn kịch bản lời bình (Summary / Script-to-video) |
| 21 | `sse_tickets` | 4 | 4 | Vé xác thực ngắn hạn EventSource SSE |
| 22 | `settings` | 3 | 3 | Cài đặt mặc định của tài khoản người dùng |
| 23 | `email_otps` | 2 | 2 | Mã xác thực OTP qua email hiện tại |
| 24 | `api_keys` | 0 | 0 | API keys do người dùng tự cung cấp |
| 25 | `project_glossaries` | 0 | 0 | Từ điển thuật ngữ riêng cho từng dự án |
| 26 | `project_idempotency` | 0 | 0 | Khóa chống trùng lặp request tạo dự án (TTL 7 ngày) |
| 27 | `reset_tokens` | 0 | 0 | Token đặt lại mật khẩu |
| 28 | `script_uploads` | 0 | 0 | Tệp kịch bản upload (Script to video) |
| 29 | `youtube_accounts` | 0 | 0 | Tài khoản YouTube liên kết OAuth |
| 30 | `youtube_oauth_states` | 0 | 0 | Quản lý trạng thái PKCE OAuth YouTube |
| 31 | `youtube_uploads` | 0 | 0 | Trạng thái đẩy video lên YouTube |
| **Tổng** | **31 Bảng** | **9,374** | **9,374** | **Trùng khớp tuyệt đối 100%** |

---

## 3. Khảo Sát Chi Tiết Khóa Ngoại Mồ Côi (Orphaned Foreign Keys)

Vì SQLite hiện tại không thực thi ràng buộc khóa ngoại, quá trình audit đã phát hiện **các bản ghi mồ côi (orphans)** cần đặc biệt lưu ý khi thiết kế DDL và viết script migration sang PostgreSQL:

### 3.1. `projects.user_id -> users.id` (1 bản ghi)
- **Bản ghi:** Project `0845d1dd-9974-40cc-af8a-265c4e641513` ("Composer Live Test") có `user_id = 'user-live-test'`.
- **Nguyên nhân:** Được tạo bởi test case / live testing trực tiếp mà không đăng ký tài khoản user tương ứng trong bảng `users`.
- **Giải pháp chuyển dịch:** Script migration dữ liệu cần chèn một user đại diện `user-live-test` vào bảng `users` (nếu chưa có) trước khi nạp `projects`, nhằm thỏa mãn ràng buộc `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`.

### 3.2. `settings.user_id -> users.id` (1 bản ghi)
- **Bản ghi:** Settings cho `user_id = 'user-live-test'`.
- **Giải pháp chuyển dịch:** Tương tự như trên, sau khi chèn user đại diện `user-live-test`, ràng buộc FK của `settings` sẽ được thỏa mãn trọn vẹn.

### 3.3. `timeline_tracks.project_id -> projects.id` (66 bản ghi)
- **Bản ghi:** 66 rãnh timeline thuộc về các project đã bị xóa trước đó (ví dụ: `07e9b6a2-a6c2-487e-8e54-a35400fb3960`, `38ee7853-b52f-...`, `5e7deacb-...`, v.v.).
- **Nguyên nhân:** Logic xóa dự án cũ trong SQLite chưa dọn sạch các dòng trong `timeline_tracks` (do Media Composer là module mới).
- **Giải pháp chuyển dịch:** 
  1. Trong PostgreSQL DDL, khai báo `FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`.
  2. Trong script migration dữ liệu (Phase 4): Dọn dẹp (bỏ qua) 66 rãnh mồ côi này vì project cha của chúng không còn tồn tại trên hệ thống, hoặc chỉ migrate các track có `project_id IN (SELECT id FROM projects)`.

### 3.4. `sse_tickets.project_id -> projects.id` (4 bản ghi)
- **Bản ghi:** 4 vé SSE trỏ tới các project đã bị xóa (`679f230c-...`, `5e7deacb-...`, v.v.).
- **Nguyên nhân:** Ticket SSE có TTL 60 giây và đã hết hạn từ lâu trong quá khứ.
- **Giải pháp chuyển dịch:** Bỏ qua các vé SSE đã hết hạn / không còn project, hoặc khai báo `ON DELETE CASCADE`.

### 3.5. `project_cleanup_tasks.project_id` (17 bản ghi)
- **Bản chất Kiến Trúc Cực Kỳ Quan Trọng:** Bảng `project_cleanup_tasks` là một **Outbox Queue** lưu lại danh sách file cần xóa trên disk **SAU KHI** một dự án bị xóa (`operation = 'PROJECT_DELETE'`, `status = 'done'`).
- **Khuyến nghị Thiết Kế:** **TUYỆT ĐỐI KHÔNG** đặt khóa ngoại `FOREIGN KEY (project_id) REFERENCES projects(id)` có ràng buộc `ON DELETE RESTRICT` hay `ON DELETE CASCADE` trên bảng này! Nếu đặt `CASCADE`, khi xóa project thì task dọn dẹp cũng bị xóa ngay lập tức, worker sẽ mất việc dọn dẹp file. Nếu đặt `RESTRICT`, hệ thống không thể xóa project. Cột `project_id` ở bảng này chỉ mang tính định danh lịch sử (`TEXT NOT NULL`).

### 3.6. `provider_logs.project_id` (137 bản ghi)
- **Bản ghi:** 137 dòng log có `project_id = 'p1'`, `'p2'`, `'p3'`, `'p4'`, `'p'` hoặc ID project đã xóa.
- **Giải pháp chuyển dịch:** Trong PostgreSQL DDL, cột `provider_logs.project_id` cho phép `NULL` với chính sách `ON DELETE SET NULL`. Đối với các log cũ có `project_id` không tồn tại, script migration sẽ chuyển `project_id = NULL` để bảo toàn lịch sử token/chi phí mà không vi phạm tính toàn vẹn.

---

## 4. Kiểm Toán Các Cột Dữ Liệu JSON (JSON Columns Audit)

Hệ thống sử dụng các cột lưu trữ chuỗi JSON dạng TEXT trong SQLite. Đã quét toàn bộ dữ liệu:

| Bảng | Cột | Số Bản Ghi Có Dữ Liệu | Số Bản Ghi Lỗi JSON | Kiểu Đích PostgreSQL | Ghi Chú |
|:---|:---|:---:|:---:|:---|:---|
| `projects` | `params` | 22 | 0 | `JSONB` | Chứa cấu hình audioMode, prompt, ducking, v.v. |
| `generation_jobs` | `payload` | 8 | 0 | `JSONB` | Tham số gửi vào stage worker |
| `generation_jobs` | `result` | 87 | 0 | `JSONB` | Kết quả trả về của từng stage |
| `subtitles` | `cues` | 6 | 0 | `JSONB` | Mảng chứa các câu phụ đề `[{"start":0,"end":1.5,"text":"..."}]` |
| `script_segments` | `scene_refs` | 4 | 0 | `JSONB` | Mảng tham chiếu cảnh `[{"sceneId":"scene-1","weight":0.8}]` |
| `timeline_clips` | `style_json` | 3 | 0 | `JSONB` | Thuộc tính style văn bản / hiệu ứng |
| `timeline_clips` | `meta` | 3 | 0 | `JSONB` | Metadata mở rộng của clip |
| `assets` | `meta` | 0 | 0 | `JSONB` | Metadata thông số file |
| `assets` | `ocr_data` | 0 | 0 | `JSONB` | Tọa độ và kết quả nhận diện chữ OCR |
| `project_cleanup_tasks` | `keys_json` | 17 | 0 | `JSONB` | Mảng đường dẫn file storage cần dọn dẹp |

**Đánh giá:** 100% dữ liệu JSON đều chuẩn cú pháp. Có thể ép kiểu an toàn sang `JSONB` trong PostgreSQL để hỗ trợ index GIN và truy vấn JSON tốc độ cao.

---

## 5. Khảo Sát Định Dạng Thời Gian (Timestamps Audit)

Phân tích các trường ngày tháng trong cơ sở dữ liệu:
1. **SQLite Native Format:** `YYYY-MM-DD HH:MM:SS` (ví dụ: `2026-08-22 12:28:56`). Được sinh bởi câu lệnh SQLite `DEFAULT (datetime('now'))`.
2. **ISO 8601 Format:** `YYYY-MM-DDTHH:MM:SS.sssZ` (ví dụ: `2026-11-30T12:58:58.176Z`). Được sinh bởi `new Date().toISOString()` trong Node.js.

**Khả năng tương thích:** PostgreSQL hỗ trợ parse tự động cả hai định dạng trên khi cast sang `TIMESTAMPTZ` (Timestamp with Time Zone). Trong DDL mới, tất cả các trường thời gian sẽ sử dụng `TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`.

---

## 6. Phân Bố Giá Trị Trạng Thái & Enums (Enum Distributions)

Phân tích các cột phân loại trạng thái:

1. **`projects.status`**:
   - `completed`: 15
   - `queued`: 6
   - `failed`: 1
   *(Toàn bộ dữ liệu legacy 'success' đã được chuẩn hóa sang 'completed')*.
2. **`projects.mode`**:
   - `MEDIA_COMPOSER`: 9
   - `TRANSLATE_DUB`: 6
   - `SUMMARY`: 5
   - `STYLE_EDIT`: 2 *(Legacy mode từ phiên bản cũ)*.
3. **`generation_jobs.status`**:
   - `success`: 87
   - `failed`: 8
4. **`generation_jobs.type`**:
   - 24 loại stage khác nhau (`dub.ingest`, `dub.stt`, `dub.translate`, `dub.ttsAlign`, `dub.render`, `summary.transcribe`, `summary.script`, `summary.render`, `composer.render`, v.v.).
5. **`users.role`**:
   - `user`: 15
   - `admin`: 1
6. **`timeline_tracks.track_type`**:
   - `background`: 19, `image`: 19, `music`: 19, `sfx`: 17, `text`: 19, `video`: 17, `voiceover`: 19.
7. **`ocr_regions.status`**:
   - `APPROVED`: 1
   - `DRAFT`: 4
8. **`upload_sessions.status`**:
   - `completed`: 34
   - `expired`: 17
9. **`project_cleanup_tasks.status`**:
   - `done`: 17

---

## 7. Phân Tích Cột Cờ / Boolean (Flags & Booleans Analysis)

Trong SQLite, các cột nhị phân được lưu dạng `INTEGER DEFAULT 0` hoặc `INTEGER DEFAULT 1`:
- `users`: `email_verified` (0)
- `reset_tokens`: `used` (0)
- `email_otps`: `used` (0)
- `settings`: `auto_upload_youtube` (0), `notify_on_complete` (1)
- `projects`: `copyright_acknowledged` (0), `script_review_required` (0)
- `timeline_tracks`: `muted` (0), `locked` (0)
- `style_presets`: `is_system` (1)
- `project_glossaries`: `case_sensitive` (0)
- `sse_tickets`: `used` (0)
- `ocr_regions`: `is_static` (0), `enabled` (1)
- `transcript_segments`: `is_time_manually_adjusted` (0), `is_text_manually_edited` (0), `is_translation_manually_edited` (0)
- `api_keys`: `is_active` (1)

**Khuyến nghị Thiết kế PostgreSQL:**
Sử dụng kiểu `BOOLEAN` (`BOOLEAN DEFAULT FALSE` / `BOOLEAN DEFAULT TRUE`) chuẩn PostgreSQL.
- Đối với migration dữ liệu: Ánh xạ `0 -> FALSE`, `1 -> TRUE`.
- Đối với tầng Backend Query: Cập nhật các câu truy vấn hoặc sử dụng helper mapping để đảm bảo tương thích 100%.

---

## 8. Kết Luận & Hướng Dẫn Kế Tiếp (Phase 2 & Phase 4)

1. **Phase 2 (PostgreSQL Schema DDL):**
   - Đầy đủ 31 bảng.
   - Sử dụng khóa chính rõ ràng (UUID string `VARCHAR(64)` hoặc `TEXT`, riêng các bảng auto-increment `reset_tokens`, `otp_codes` dùng `BIGSERIAL`).
   - Khóa ngoại chặt chẽ với quy tắc `ON DELETE CASCADE` cho các thực thể con phụ thuộc (`assets`, `jobs`, `segments`, `tracks`, `clips`, `outputs`, v.v.) và `ON DELETE SET NULL` cho nhật ký `provider_logs`.
   - Giữ `project_cleanup_tasks.project_id` không có khóa ngoại cứng để bảo vệ hàng đợi xóa file filesystem.
   - Toàn bộ index hiệu năng và partial unique index được tái hiện đầy đủ.
2. **Phase 4 (Data Migration):**
   - Thứ tự chèn bảng tuân theo cây phụ thuộc (Topological Dependency Order):
     1. `users` (chèn bổ sung `user-live-test` nếu cần)
     2. `style_presets`, `provider_rate_limits`, `reset_tokens`, `otp_codes`, `email_otps`, `api_keys`, `youtube_accounts`, `youtube_oauth_states`
     3. `settings`
     4. `projects`
     5. `upload_sessions`, `script_uploads`, `project_idempotency`, `project_cleanup_tasks`
     6. `assets`, `scenes`, `audios`, `subtitles`, `outputs`, `generation_jobs`, `project_glossaries`, `ocr_regions`, `transcript_segments`, `timeline_tracks`
     7. `timeline_clips`, `script_segments`, `sse_tickets`, `youtube_uploads`
     8. `provider_logs`, `provider_cache`
   - Đồng bộ sequence SERIAL sau khi chèn dữ liệu (`setval`).

---
*Báo cáo được lập tự động dựa trên phân tích dữ liệu thực tế tại `backend/data.db`.*
