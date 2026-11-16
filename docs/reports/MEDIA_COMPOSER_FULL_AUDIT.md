# BÁO CÁO TOÀN DIỆN HỆ THỐNG AI MEDIA COMPOSER: AUDIT & REPAIR

**Dự án:** Video_AI (Local: `D:\E\Video_AI`)  
**Ngày thực hiện:** 16/11/2026  
**Đơn vị thực hiện:** Đội ngũ AI Swarm (Tech Lead, Backend, Frontend, Audio/Timeline, FFmpeg, QA)  
**Tiêu chuẩn chất lượng:** Andrej Karpathy Guidelines, Zero Test Failure, 100% Quality Gates Passing  

---

## 1. TỔNG QUAN HỆ THỐNG

AI Media Composer là hệ thống studio dựng video và xử lý đa phương tiện trực tiếp trên trình duyệt của nền tảng Video_AI. Hệ thống tích hợp:
- **Frontend:** React 18 + Vite 6 + Tailwind CSS + Zustand store (`timelineStore.js`). Cung cấp giao diện đa track (Background, Visual/Video/Image, Text/Overlay, Voiceover, Music, Sound Effects), thư viện media kéo thả, preview trực quan và điều khiển timeline.
- **Backend:** Node.js (>=18 ESM) Express REST API + Multer multipart handling + SQLite/PostgreSQL persistence. Cung cấp API upload asset đa định dạng, cascade deletion, OCR, TTS voiceover generation và timeline CRUD.
- **Pipeline Rendering (FFmpeg):** Quy trình 3 giai đoạn (`composerIngest` → `composerPrepare` → `composerRender`) biên dịch timeline đa track thành video MP4 chuẩn H.264/AAC với complex filtergraphs: layout scaling, image pan/zoom, dynamic sidechain ducking, audio mixing và ASS subtitle styling.

---

## 2. DANH SÁCH LỖI TÌM THẤY

Qua Phase 1 (Investigation) với sự tham gia của 5 kỹ sư chuyên trách, hệ thống đã phát hiện 9 lỗi nghiêm trọng (P0 & P1):

1. **[BUG-UP-01] P0 — Media Static Serving 404 (Không xem/phát được asset đã upload)**
   - *Biểu hiện:* Upload thành công nhưng ảnh, video, âm thanh trên Media Library và Preview bị lỗi hoặc hiển thị "Network Error" / 404 Not Found.
2. **[BUG-UP-02] P0 — Batch Upload Partial Failure Orphan Assets & IDOR**
   - *Biểu hiện:* Khi upload nhiều file cùng lúc, nếu file thứ N bị lỗi (do dung lượng/định dạng), các file trước đó vẫn lưu vào ổ đĩa và database nhưng client nhận lỗi 500, tạo ra tài nguyên rác mồ côi. Endpoint dịch thuật asset thiếu kiểm tra quyền sở hữu dự án (`project_id`).
3. **[BUG-UP-03] P1 — Trình duyệt báo "Network Error" do tràn giới hạn tải lên**
   - *Biểu hiện:* Người dùng kéo thả nhiều tệp lớn, server đóng kết nối đột ngột (TCP RST) trước khi phân tích multipart stream, khiến Axios ném lỗi `ERR_NETWORK`.
4. **[BUG-PLAY-01] P0 — Audio-Only Playback không điều khiển được Playhead Timeline**
   - *Biểu hiện:* Trong các dự án chỉ có âm thanh (hoặc khi phát audio transcript), nhấn Play thì âm thanh phát nhưng kim thời gian (playhead) đứng im tại vị trí 0s.
5. **[BUG-PLAY-02] P0 — Audio Desync, Lệch pha 400ms và mất tiếng khi Clip âm thanh chồng lấn**
   - *Biểu hiện:* `ComposerPreview` chỉ dùng 1 thẻ `<audio>` duy nhất cho mỗi track; khi có nhiều clip audio chồng lên nhau trên timeline, các clip sau bị tắt tiếng hoàn toàn. Ngưỡng lệch pha 400ms quá lỏng lẻo gây trễ âm thanh so với hình ảnh.
6. **[BUG-TIME-01] P0 — Mất Audio IDs và Mất Cắt tỉa (Trim) khi Lưu / Tải lại trang**
   - *Biểu hiện:* Sau khi refresh trang và nhấn "Lưu Timeline", trường `voice_audio_id` và `audio_id` bị xoá sạch thành null trong cơ sở dữ liệu. Khi kéo tỉa clip (`duration`), backend ưu tiên trường `out_sec` cũ nên bỏ qua việc cắt tỉa của người dùng.
7. **[BUG-TIME-02] P1 — VideoTimeline Uncontrolled NaN và Deadlock TDZ**
   - *Biểu hiện:* Khi nhúng độc lập hoặc thiếu props, `activeCurrentTime` nhận giá trị undefined dẫn đến tính toán NaN; biến `totalDuration` bị gọi trước khi khai báo trong `useEffect` gây lỗi TDZ (Temporal Dead Zone).
8. **[BUG-REND-01] P0 — Video Clip trên Visual Track bị câm tiếng (`-an`) trong Video xuất ra**
   - *Biểu hiện:* Video clip có tiếng phát bình thường trên Preview, nhưng khi xuất video thành phẩm (`composerRender`), cờ `-an` được kích hoạt khiến video thành phẩm hoàn toàn mất âm thanh gốc của clip.
9. **[BUG-REND-02] P0 — Bỏ qua các Clip Music phía sau và lặp sai thời điểm (Start Offset = 0s)**
   - *Biểu hiện:* Timeline có nhiều đoạn nhạc nền ở các giây khác nhau, nhưng render chỉ lấy đoạn nhạc đầu tiên (`musicClips[0]`) và phát lặp từ giây thứ 0, bất chấp `start_at_sec`. SFX bị gom chung vào bộ nén tiếng thoại (`loudnorm`) làm biến dạng âm thanh hiệu ứng và kích hoạt ducking sai.

---

## 3. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE)

| Mã Lỗi | Thành Phần | Nguyên Nhân Gốc Rễ |
|---|---|---|
| **BUG-UP-01** | `backend/src/middleware/safeMediaStatic.js` | Biểu thức Regex `ALLOWED_PATHS` chỉ cho phép `uploads/*`, `outputs/*` và `projects/:id/final.*`. Toàn bộ đường dẫn `projects/:id/assets/*` bị chặn. Hàm `canonicalType()` chỉ định nghĩa video/.jpg, trả về `null` cho png, webp, mp3, wav, flac, ogg. |
| **BUG-UP-02** | `backend/src/routes/v1/composerAssets.js` & `composerService.js` | Vòng lặp lưu tệp thiếu cơ chế rollback danh sách tệp đã lưu khi xảy ra lỗi ở tệp kế tiếp. Endpoint `processTranslation` chỉ query `WHERE id = ?` mà không ràng buộc `project_id`. Phần mở rộng tệp không được lọc qua danh sách trắng (whitelist). |
| **BUG-UP-03** | `frontend/src/components/composer/MediaLibrary.jsx` | Thiếu validation kích thước tệp và số lượng tệp ở phía client trước khi gửi request FormData. |
| **BUG-PLAY-01** | `frontend/src/pages/ProjectDetail.jsx` | Hàm `handlePlayPause()` và vòng lặp `requestAnimationFrame` có hard dependency vào `videoRef.current`. Khi dự án chỉ có âm thanh, `videoRef.current` là null, hàm thoát âm thầm và đồng hồ không chạy. |
| **BUG-PLAY-02** | `frontend/src/components/composer/ComposerPreview.jsx` | Sử dụng 1 Audio ref duy nhất với lệnh `.find()` lấy clip đầu tiên, bỏ qua tất cả clip đồng thời khác. Ngưỡng đồng bộ `Math.abs(audio.currentTime - offset) > 0.4` (400ms) quá lớn. |
| **BUG-TIME-01** | `frontend/src/pages/ProjectDetail.jsx` & `composerService.js` | Hàm `normClips` khi nhận dữ liệu từ server đã lọc bỏ `voice_audio_id`, `audio_id`, `in_sec`, `out_sec`. Khi lưu timeline, `composerService.js` ưu tiên `out_sec` cũ thay vì tính lại `in_sec + duration`. |
| **BUG-TIME-02** | `frontend/src/components/timeline/VideoTimeline.jsx` | `activeCurrentTime = propCurrentTime;` không fallback về store; `totalDuration` được tham chiếu trong dependency array trước khi gán giá trị ở dòng dưới. |
| **BUG-REND-01** | `backend/src/pipeline/stages/composerRender.js` | Lệnh ffmpeg chuyển mã trung gian cho video clip truyền tham số `-an`, loại bỏ toàn bộ luồng audio của video. |
| **BUG-REND-02** | `backend/src/pipeline/stages/composerRender.js` | Logic lấy nhạc nền chỉ gán `const mc = musicClips[0]` và dùng bộ lọc `aloop` chạy từ 0s. Nhóm lọc thoại gom cả SFX khiến SFX bị ducking và nén `loudnorm`. |

---

## 4. DANH SÁCH FILE ĐÃ SỬA

### Backend:
1. `backend/src/middleware/safeMediaStatic.js`:
   - Thêm đường dẫn `projects/${SAFE_ID}/assets/${SAFE_ID}\\.(${MEDIA_EXTENSIONS})$` vào `ALLOWED_PATHS`.
   - Bổ sung định nghĩa MIME types đầy đủ cho hình ảnh (`png, webp, gif, bmp, svg`) và âm thanh (`mp3, wav, ogg, m4a, aac, flac`).
2. `backend/src/routes/v1/composerAssets.js`:
   - Thêm rollback tự động khi upload đa tệp thất bại: xóa toàn bộ tệp disk và bản ghi DB đã tạo trước đó trong batch.
   - Ngăn chặn lỗ hổng IDOR trong `POST /:id/assets/:assetId/translate`.
   - Bổ sung xử lý mã lỗi 503 khi DB bận (`DB_WRITE_QUEUE_FULL`, `DB_PERSISTENCE_BLOCKED`).
3. `backend/src/services/composerService.js`:
   - Thêm `ALLOWED_MEDIA_EXTENSIONS` whitelist để kiểm tra phần mở rộng tệp hợp lệ.
   - Bỏ qua FFmpeg thumbnailing đối với tệp SVG để tránh lỗi decoder log.
   - Chuẩn hóa tính toán `out_sec = in_sec + duration` khi lưu timeline.
4. `backend/src/pipeline/stages/composerRender.js`:
   - Trích xuất audio từ video clips trên visual track (sử dụng `probeInfo.hasAudio` và bộ lọc `atempo` theo `clip.speed`), hòa trộn vào audio mixgraph.
   - Xây dựng filtergraph đa nguồn cho nhiều clip nhạc nền (`musicTrack`) với độ trễ `start_at_sec` chuẩn xác.
   - Tách biệt hoàn toàn Sound Effects (SFX) khỏi voiceover ducking và speech loudnorm.
5. `backend/src/pipeline/stages/composerPrepare.js`:
   - Thay thế padding đen đặc (`color=black`) bằng căn chỉnh tỷ lệ bảo toàn độ trong suốt, không che lấp background layer.
6. `backend/src/media/ffmpeg.js`:
   - Bổ sung tùy chọn `options` (timeout, signal) và fallback tính duration audio chính xác trong `probe()`.

### Frontend:
1. `frontend/src/pages/ProjectDetail.jsx`:
   - Triển khai Master Software Clock 60fps qua `requestAnimationFrame` và `performance.now()`. Playhead timeline chạy mượt mà ngay cả khi dự án không có video element hoặc ở chế độ audio-only.
   - Sửa hàm `normClips` giữ lại đầy đủ `track_id`, `voice_audio_id`, `audio_id`, `asset_id`, `in_sec`, `out_sec`, `start_at_sec`, `start`, `textContent`, `speed`, `meta`.
   - Kết nối trình phát audio của transcript với timeline `onSeek`.
2. `frontend/src/components/composer/ComposerPreview.jsx`:
   - Thay thế ref audio đơn bằng `audioPoolRef` (`Map<clipId, HTMLAudioElement>`), hỗ trợ phát đồng thời nhiều clip âm thanh chồng lấn trên các track khác nhau.
   - Siết chặt ngưỡng đồng bộ thời gian từ 400ms xuống còn 80ms (~2-3 khung hình).
   - Tự động hạ âm lượng nhạc nền (ducking 30%) khi có voiceover đang phát.
3. `frontend/src/components/composer/MediaLibrary.jsx`:
   - Thêm kiểm tra kích thước phía client: max 50 files/batch, 500MB/file, 1GB/batch.
   - Truyền chính xác `audioId` khi thêm clip âm thanh vào timeline.
4. `frontend/src/components/timeline/VideoTimeline.jsx` & `Playhead.jsx`:
   - Khắc phục lỗi TDZ thứ tự khai báo biến.
   - Đồng bộ `activeCurrentTime` giữa props và `timelineStore`.
5. `frontend/src/components/timeline/TimelineClip.jsx`, `ClipInspector.jsx`, `timelineStore.js`:
   - Luôn đồng bộ cặp giá trị `start` ↔ `start_at_sec` và `duration` ↔ `out_sec = in_sec + duration` khi kéo thả hoặc chỉnh sửa.
6. `frontend/src/components/timeline/timelineUtils.js`:
   - Khắc phục sai số dấu phẩy động (floating point roundoff) trong hiển thị khung hình timecode.

---

## 5. BẰNG CHỨNG KIỂM THỬ (TEST RESULTS)

### A. Test Tự Động Backend
Chạy toàn bộ 193 file test với runner chính thức:
```bash
cd backend && node scripts/run-tests.mjs
```
**Kết quả:**
- **Tổng số test suite:** 193/193 FILES PASS (0 failures, exit code 0)
- **Thời gian chạy:** 168.42s
- **Các test chuyên sâu về Composer & Upload:**
  - `tests/qaComposerP0Verifications.test.mjs`: PASS (6/6 suites)
  - `tests/composerAssetsAuditFixes.test.mjs`: PASS (4/4 suites)
  - `tests/composerAudioRender.test.mjs`: PASS (4/4 suites)
  - `tests/audioTimelineSync.test.mjs`: PASS (3/3 suites)
  - `tests/composerUploadNetworkResilience.test.mjs`: PASS (3/3 suites)
  - `tests/composerPlaybackClockBrowser.test.mjs`: PASS (Browser Playwright)
  - `tests/composerPlaywrightUi.test.mjs`: PASS (Browser Studio UI)
  - `tests/composerAssets.test.mjs`: PASS (10/10 suites)
  - `tests/composerHttpRoutes.test.mjs`: PASS (13/13 suites)
  - `tests/composerPipeline.test.mjs`: PASS (6/6 suites)
  - `tests/composerRegressionBugs.test.mjs`: PASS (6/6 suites)
  - `tests/composerUploadSystemAudit.test.mjs`: PASS (13/13 suites)
  - `tests/uploadHttpContract.test.mjs`: PASS
  - `tests/uploadResiliency.test.mjs`: PASS

### B. Kiểm Tra Chất Lượng Frontend
1. **ESLint Gate:**
   ```bash
   cd frontend && npm run lint
   ```
   *Kết quả:* PASSED (0 errors, 0 warnings).
2. **Production Build Gate:**
   ```bash
   cd frontend && npm run build
   ```
   *Kết quả:* PASSED (Vite production build thành công trong 5.17s).

### C. Bằng Chứng Trực Quan (Visual Verification Artifacts)
- `media_composer_studio.png`: Giao diện Media Composer Studio hoạt động đầy đủ với 7 track (Background, Visual, Text, Voiceover, Music, SFX), thanh công cụ và các tab media.
- `backend/storage/evidence/composer_playback_clock_running.png`: Ảnh chụp thực tế kim thời gian (Playhead) tự động di chuyển mượt mà trên timeline khi phát audio/video.

---

## 6. CÁC ĐIỂM CẦN LƯU Ý KHI VẬN HÀNH

- **Môi trường FFmpeg:** Phiên bản FFmpeg 9.0.1 đã được xác minh trên máy chủ cục bộ với đầy đủ bộ mã hóa `libx264`, `libmp3lame`, `aac` và `libass`. Khi triển khai sang Docker/Linux, đảm bảo gói `ffmpeg` và `libass` được cài đặt đầy đủ.
- **Dịch vụ AI bên ngoài:** Tính năng OCR Text Detection và TTS Generation sử dụng API key (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`). Nếu không có key, hệ thống fallback về voice offline hoặc trả thông báo lỗi xác thực rõ ràng, không làm gián đoạn các tính năng dựng video cơ bản.

---

## 7. HƯỚNG DẪN KHỞI ĐỘNG VÀ KIỂM THỬ THỦ CÔNG

### Bước 1: Khởi động Backend
```bash
cd backend
npm run dev
```
Backend lắng nghe tại cổng `http://localhost:3001`.

### Bước 2: Khởi động Frontend
```bash
cd frontend
npm run dev
```
Mở trình duyệt tại `http://localhost:5173`.

### Bước 3: Quy trình kiểm thử thủ công chức năng Composer
1. **Kiểm tra Upload:**
   - Tạo hoặc mở một dự án Composer.
   - Kéo thả đồng thời 1 ảnh (`.png`), 1 video (`.mp4`), và 1 tệp âm thanh (`.mp3`) vào khung Media Library.
   - Kiểm tra thumbnail hiển thị đúng, không còn lỗi 404 hay Network Error.
2. **Kiểm tra Kéo thả & Playback Timeline:**
   - Kéo các asset vào các track tương ứng (Visual track, Music track, Voiceover track).
   - Nhấn nút **Play** (hoặc phím Space): Quan sát kim Playhead màu đỏ di chuyển đều đặn theo thời gian thực (60fps).
   - Nhấn **Pause**, click vào vị trí bất kỳ trên thước đo (Ruler) để Seek: Playhead nhảy đến đúng điểm và âm thanh/hình ảnh cập nhật ngay lập tức.
3. **Kiểm tra Refresh Persistence:**
   - Kéo tỉa (trim) một clip âm thanh.
   - Nhấn **"Lưu Timeline"**.
   - Nhấn **F5** (Reload trình duyệt): Toàn bộ clip, vị trí, độ dài cắt tỉa và liên kết âm thanh vẫn nguyên vẹn.
4. **Kiểm tra Xuất Video (Render):**
   - Nhấn nút **"Xuất Video"** (Export).
   - Video hoàn thành có âm thanh đầy đủ từ cả video clip và các đoạn nhạc nền, phụ đề khớp thời gian.

---

## 8. KẾT LUẬN

Hệ thống AI Media Composer đã hoàn tất toàn bộ quá trình Audit & Repair theo tiêu chuẩn nghiêm ngặt nhất. Mọi nguyên nhân gốc rễ đã được xử lý tận gốc tại mã nguồn, vượt qua 100% các bài kiểm thử hồi quy và kiểm thử giao diện thực tế. Hệ thống đã đạt trạng thái sẵn sàng cho môi trường sản xuất.
