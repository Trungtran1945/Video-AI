# 02 — Thiết kế cơ sở dữ liệu

# Current Implementation (CURRENT)

> Nguồn đối chiếu (source of truth, branch main): `backend/src/db/schema.js` (toàn file).

CURRENT có đúng **30 tables** (verbatim):
`users`, `reset_tokens`, `email_otps`, `settings`, `projects`, `assets`, `generation_jobs`, `scenes`, `script_segments`, `timeline_tracks`, `timeline_clips`, `audios`, `subtitles`, `outputs`, `youtube_uploads`, `script_uploads`, `youtube_accounts`, `youtube_oauth_states`, `api_keys`, `provider_logs`, `provider_rate_limits`, `provider_cache`, `transcript_segments`, `ocr_regions`, `style_presets`, `project_glossaries`, `sse_tickets`, `project_idempotency`, `project_cleanup_tasks`, `upload_sessions`.

- **Không FK constraints cứng (manual cleanup)**: Các lệnh `CREATE TABLE` không khai báo `FOREIGN KEY` ràng buộc tầng database engine; việc dọn dẹp quan hệ được xử lý trong mã nguồn (vd: khi xoá project, đặt `provider_logs.project_id = NULL`, dọn `assets`, `outputs`, v.v.).
- **Lowercase enums**: `status` / `role` lưu dạng chữ thường (`pending`, `queued`, `running`, `completed`, `failed`, `cancelled`, `user`, `admin`...), không dùng enum UPPERCASE của Prisma (SQLite không có native enum).
- **projects.status='completed'**: Pipeline đánh dấu `'completed'` khi kết thúc thành công (chuẩn hoá các row legacy `'success'` sang `'completed'`).
- **projects hỗ trợ 4 modes**: `MEDIA_COMPOSER` (Flagship mới), `TRANSLATE_DUB`, `SCRIPT_TO_VIDEO`, và `SUMMARY` (Legacy).
- **projects bổ sung tracking chi tiết**:
  - `transcript_version`: Tăng khi sửa transcript hoặc sửa mask APPROVED/DRAFT để đồng bộ cờ `outputStale`.
  - `run_token`, `lease_expires_at`: Quản lý quyền chạy độc quyền (lease ownership) chống race condition giữa các worker/process.
  - `started_at`, `last_heartbeat_at`, `recovery_reason`: Heartbeat phục vụ phát hiện job bị treo và tự động phục hồi sau restart server.
  - `copyright_acknowledged`, `copyright_ack_at`: Ghi nhận bắt buộc xác nhận bản quyền trước khi pipeline khởi chạy.
  - `cancelled_at`, `expires_at`: Quản lý thời điểm huỷ và hạn lưu trữ (retention policy).
  - `script_upload_id`, `script_key`, `script_hash`, `script_version`, `script_review_required`: Quản lý provenance và review gate cho chế độ `SCRIPT_TO_VIDEO`.
  - `next_cleanup_attempt_at`: Quản lý backoff khi dọn dẹp dự án.
- **Bảng `timeline_tracks` (Mới - Media Composer)**:
  - Quản lý các rãnh độc lập trên timeline: `id`, `project_id`, `track_type` (`'background'`, `'image'`, `'voiceover'`, `'music'`, `'text'`), `name`, `order_index`, `muted` (0/1), `volume` (0..2.0), `locked` (0/1), `created_date`.
- **Bảng `timeline_clips` bổ sung các trường mở rộng**:
  - `track_id`, `clip_type` (`'image'`, `'background'`, `'voiceover'`, `'music'`, `'text'`), `asset_id`, `text_content`, `style_json`, `volume`, `fade_in_sec`, `fade_out_sec`, `meta`.
- **Bảng `assets` bổ sung các trường mở rộng**:
  - `user_id`, `name`, `mime_type`, `byte_size`, `thumbnail_key`, `ocr_text`, `ocr_data`, `translation_text`, `translation_target_lang`, `order_index`, `created_date`.
- **settings (~15 cột)**: Mặc định `voice_provider='edge_tts'`, `default_style='cinematic'`, `aspect_ratio='16:9'`, `default_duration=60`, `max_retries=3`, cấu hình provider mặc định (`active_llm_provider`, `active_voice_provider`, v.v.).
- **ocr_regions bổ sung mask lifecycle**: `status TEXT DEFAULT 'DRAFT'` (`DRAFT` | `APPROVED` | `DISABLED`), `enabled INTEGER DEFAULT 1`. Chỉ mask `APPROVED` mới được đưa vào render. Mask `APPROVED` là bất biến (immutable về toạ độ, thời gian và kiểu mask).
- **Chi tiết các bảng mở rộng**:
  - `email_otps`: Xác thực đăng nhập qua OTP gửi về email (`email`, `otp_hash`, `purpose`, `expires_at`, `attempts`, `used`).
  - `reset_tokens`: Lưu `token = sha256(raw_token)`, `expires_at`, `used` cho luồng quên mật khẩu.
  - `script_uploads`: Lưu thông tin file kịch bản tải lên (`sha256`, `char_count`, `storage_key`, `filename`).
  - `youtube_accounts` & `youtube_oauth_states`: Quản lý liên kết OAuth Google/YouTube (`channel_id`, `access_token`, `refresh_token`) và bảo mật PKCE state.
  - `project_glossaries`: Bảng từ điển thuật ngữ riêng cho từng project phục vụ dịch thuật nhất quán (`term`, `translation`, `notes`).
  - `sse_tickets`: Lưu `ticket_hash = sha256(ticket)`, `expires_at` (TTL 30s), `used = 0|1` cho vé EventSource một lần an toàn.
  - `project_idempotency`: Lưu `(user_id, idem_key)`, `request_fingerprint` (SHA-256 body), `expires_at` (TTL 7 ngày) chống tạo project trùng lặp.
  - `project_cleanup_tasks`: Outbox dọn file filesystem sau DELETE project (`status = pending|failed|completed`), commit cùng transaction với DB wipe.
  - `upload_sessions`: Upload resumable TUS-style có `last_activity_at`, `expires_at`, index `(status, expires_at)` và state machine `pending → completing → completed|expired`.

> **Lưu ý Triển khai:** Thiết kế target hướng tới Prisma ORM + PostgreSQL. Triển khai hiện tại dùng `sql.js` (WebAssembly SQLite) với raw SQL trực tiếp (`backend/src/db/schema.js`).

---

## 1. Thực thể (Entities) & Quan hệ

```
User 1──* Project 1──* Asset
                   │
                   ├──* GenerationJob
                   ├──* TimelineTrack     (MEDIA_COMPOSER) 1──* TimelineClip
                   ├──* Scene             (SUMMARY)
                   ├──* ScriptSegment     (SUMMARY / SCRIPT_TO_VIDEO)
                   ├──* TimelineClip      (MEDIA_COMPOSER / SUMMARY / SCRIPT_TO_VIDEO)
                   ├──* TranscriptSegment (TRANSLATE_DUB)
                   ├──* OcrRegion         (TRANSLATE_DUB)
                   ├──* ProjectGlossary   (TRANSLATE_DUB / SCRIPT_TO_VIDEO)
                   ├──* Audio
                   ├──* Subtitle
                   └──* Output 1──* YouTubeUpload

User 1──* ApiKey
User 1──1 Settings
User 1──* EmailOtp
User 1──* ResetToken
User 1──* YouTubeAccount
StylePreset (bảng dùng chung, seed 13 phong cách)
Project 1──* ProviderLog
GenerationJob 1──* ProviderLog
```

---

## 2. Chi tiết 30 Bảng trong Cơ sở Dữ liệu (`backend/src/db/schema.js`)

### 2.1. Nhóm Người dùng & Bảo mật
1. **`users`**: Tài khoản người dùng (`id`, `email`, `password`, `role`, `name`, `refresh_token`, `refresh_expires`, `created_date`, `updated_date`).
2. **`reset_tokens`**: Mã đặt lại mật khẩu (`id`, `email`, `token` dạng SHA-256 hash, `expires_at`, `used`).
3. **`email_otps`**: Mã OTP xác thực qua email (`id`, `email`, `otp_hash`, `purpose`, `expires_at`, `attempts`, `max_attempts`, `used`).
4. **`api_keys`**: Quản lý API key của người dùng (`id`, `user_id`, `provider`, `key` mã hoá AES-256-GCM, `key_preview`, `is_active`, `tier`, `priority`, `label`).

### 2.2. Nhóm Cấu hình & Dự án
5. **`settings`**: Cài đặt mặc định của user (`user_id`, `default_language`, `default_style`, `default_duration`, `max_retries`, `aspect_ratio`, `active_llm_provider`, `active_voice_provider`, `voice_provider`, v.v.).
6. **`projects`**: Thông tin dự án cốt lõi:
   - Cơ bản: `id`, `user_id`, `mode` (`'MEDIA_COMPOSER'`, `'SUMMARY'`, `'TRANSLATE_DUB'`, `'SCRIPT_TO_VIDEO'`), `title`, `status` (`'pending'`, `'queued'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'`), `language`, `style`, `target_duration_sec`, `aspect_ratio`, `params` (JSON).
   - Nguồn media: `source_video_id`, `source_video_key`, `video_hash`.
   - Nguồn kịch bản: `script_upload_id`, `script_key`, `script_hash`, `script_version`, `script_review_required`.
   - Vòng đời & Bản quyền: `copyright_acknowledged`, `copyright_ack_at`, `cancelled_at`, `expires_at`, `next_cleanup_attempt_at`.
   - Điều phối & Heartbeat: `progress`, `transcript_version`, `run_token`, `lease_expires_at`, `started_at`, `last_heartbeat_at`, `recovery_reason`.
7. **`assets`**: File tài nguyên phụ trợ & Media Library (`id`, `project_id`, `user_id`, `kind` ['image'/'background'/'voiceover'/'music'/'raw_video'], `name`, `mime_type`, `byte_size`, `thumbnail_key`, `storage_key`, `ocr_text`, `ocr_data`, `translation_text`, `translation_target_lang`, `order_index`, `meta`, `created_date`).
8. **`generation_jobs`**: Tiến trình thực thi từng công đoạn (`id`, `project_id`, `type`, `status`, `progress`, `step`, `error_message`, `payload`, `result`, `attempts`, `next_retry_at`).

### 2.3. Nhóm Dữ liệu Video & Timeline theo Chế độ
9. **`timeline_tracks`** (`MEDIA_COMPOSER`): Các rãnh dòng thời gian độc lập (`id`, `project_id`, `track_type` ['background'/'image'/'voiceover'/'music'/'text'], `name`, `order_index`, `muted`, `volume`, `locked`, `created_date`).
10. **`timeline_clips`** (`MEDIA_COMPOSER` / `SUMMARY` / `SCRIPT_TO_VIDEO`): Phân đoạn clip trên timeline kết xuất (`id`, `project_id`, `track_id`, `order_num`, `order_index`, `clip_type` ['image'/'background'/'voiceover'/'music'/'text'], `source_type`, `ref_id`, `asset_id`, `start_at_sec`, `in_sec`, `out_sec`, `speed`, `volume`, `fade_in_sec`, `fade_out_sec`, `text_content`, `style_json`, `meta`, `transition_in`, `transition_out`).
11. **`scenes`** (`SUMMARY`): Phân đoạn cảnh quay phát hiện được (`id`, `project_id`, `start_sec`, `end_sec`, `thumbnail_key`, `description`, `embedding`).
12. **`script_segments`** (`SUMMARY` / `SCRIPT_TO_VIDEO`): Đoạn kịch bản lời bình (`id`, `project_id`, `order_num`, `narration`, `target_duration_sec`, `scene_refs`, `voice_audio_id`, `visual_prompt`).
13. **`transcript_segments`** (`TRANSLATE_DUB`): Từng câu thoại trích xuất từ audio (`id`, `project_id`, `index_num`, `start_sec`, `end_sec`, `text`, `translation`, `speaker`, `tts_audio_id`, `subtitle_id`, `is_time_manually_adjusted`, `is_text_manually_edited`, `is_translation_manually_edited`, `wpm_warning`).
14. **`ocr_regions`** (`TRANSLATE_DUB`): Vùng che hardsub video (`id`, `project_id`, `start_sec`, `end_sec`, `ratio_x`, `ratio_y`, `ratio_w`, `ratio_h`, `type` ['blur'/'solid'], `blur_radius`, `opacity`, `enabled`, `status` ['DRAFT'/'APPROVED'/'DISABLED'], `source` ['AUTO'/'MANUAL'/'LEGACY_OCR'], `is_static`).
15. **`style_presets`**: 13 phong cách dịch dựng sẵn (`slug`, `name`, `description`, `system_prompt`, `is_system`).
16. **`project_glossaries`**: Bảng thuật ngữ chuyên ngành của dự án (`id`, `project_id`, `term`, `translation`, `notes`).
17. **`script_uploads`**: Tệp kịch bản đã upload (`id`, `user_id`, `filename`, `storage_key`, `char_count`, `sha256`).

### 2.4. Nhóm Media Đầu ra & Xuất bản
18. **`audios`**: File âm thanh sinh ra (`id`, `project_id`, `kind`, `storage_key`, `duration_sec`, `provider`, `model`).
19. **`subtitles`**: File phụ đề tạo ra (`id`, `project_id`, `format`, `language`, `storage_key`, `cues`).
20. **`outputs`**: Video thành phẩm cuối cùng (`id`, `project_id`, `storage_key`, `status`, `duration_sec`, `thumbnail_key`, `transcript_version`).
21. **`youtube_uploads`**: Trạng thái đẩy video lên YouTube (`id`, `output_id`, `status`, `youtube_video_id`, `privacy`, `error`).
22. **`youtube_accounts`**: Tài khoản YouTube liên kết (`id`, `user_id`, `channel_id`, `channel_title`, `access_token`, `refresh_token`, `token_expiry`).
23. **`youtube_oauth_states`**: Quản lý phiên OAuth PKCE YouTube (`state`, `code_verifier`, `user_id`, `expires_at`).

### 2.5. Nhóm Quản trị, Giới hạn & Vận hành
24. **`provider_logs`**: Nhật ký chi tiết mọi cuộc gọi AI (`id`, `project_id`, `job_id`, `provider`, `type`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `duration_ms`, `status`, `error`).
25. **`provider_rate_limits`**: Cấu hình RPM, RPD của các provider (`id`, `provider`, `tier`, `requests_per_minute`, `requests_per_day`, `concurrency`).
26. **`provider_cache`**: Bộ nhớ đệm kết quả gọi AI (`id`, `input_hash`, `provider`, `type`, `model`, `response`, `expires_at`).
27. **`sse_tickets`**: Vé xác thực ngắn hạn EventSource (`ticket_hash`, `user_id`, `project_id`, `expires_at`, `used`).
28. **`project_idempotency`**: Khoá chống trùng lặp request tạo dự án (`id`, `user_id`, `idem_key`, `request_fingerprint`, `project_id`, `expires_at`).
29. **`project_cleanup_tasks`**: Outbox dọn file filesystem sau DELETE project (`id`, `operation`, `operation_key`, `payload`, `status`, `attempts`, `next_attempt_at`).
30. **`upload_sessions`**: Phiên upload resumable kiểu TUS (`id`, `user_id`, `filename`, `size`, `mime`, `received_bytes`, `storage_key`, `video_hash`, `status`, `expires_at`).

---

## 3. Chỉ mục quan trọng (Indexes)

- `idx_generation_jobs_project_type`: `generation_jobs(project_id, type)` (UNIQUE) — đảm bảo mỗi stage chỉ có đúng 1 job hiện tại.
- `idx_projects_user_status`: `projects(user_id, status)` — đếm nhanh số project `running` để kiểm soát giới hạn concurrency.
- `idx_transcript_segments_project`: `transcript_segments(project_id, index_num)` — truy vấn và sắp xếp câu thoại theo thứ tự.
- `idx_ocr_regions_project`: `ocr_regions(project_id, status, enabled)` — nạp nhanh danh sách mask `APPROVED` khi render.
- `idx_provider_cache_hash`: `provider_cache(input_hash)` — tra cứu cache O(1).
- `idx_cleanup_tasks_due`: `project_cleanup_tasks(status, next_attempt_at)` — quét tác vụ dọn dẹp đến hạn.
- `idx_upload_sessions_status_expires`: `upload_sessions(status, expires_at)` — quét phiên upload hết hạn.

---

## 4. Quyết định Thiết kế Cốt lõi (Design Decisions)

1. **sql.js in-memory + File Persistence**: Dùng SQLite thông qua WebAssembly, mọi thao tác ghi diễn ra trên bộ nhớ và được đẩy ra file `data.db` bằng cơ chế ghi atomic memory snapshot. Single-writer lock file (`data.db.writer.lock`) ngăn ngừa xung đột đa tiến trình.
2. **Optimistic Concurrency với `transcript_version`**: Khi người dùng chỉnh sửa transcript hoặc mask, `projects.transcript_version` được tăng lên. Bảng `outputs` lưu lại phiên bản lúc render; nếu version lệch, cờ `outputStale: true` báo hiệu cần kết xuất lại.
3. **Mask Lifecycle & Tính Bất Biến**: Mask `APPROVED` được coi là hợp đồng kết xuất bất biến (không thể sửa toạ độ hay thời gian khi đang APPROVED; phải chuyển về `DRAFT` để chỉnh sửa).
4. **Resumable Upload Sessions**: Quản lý phiên upload theo chunk bằng bảng `upload_sessions`, có khả năng tự phục hồi khi máy chủ khởi động lại.
