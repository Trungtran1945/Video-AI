# 05 — Thiết kế Pipeline Chi tiết

Tài liệu này đi sâu vào **thuật toán cốt lõi** và các công đoạn thực thi của **bốn chế độ sản xuất video tự động**:
- `MEDIA_COMPOSER`: **Biên tập Video Đa phương tiện & Đa rãnh** (Flagship — kết hợp ảnh, nhạc nền, lồng tiếng AI và phụ đề ASS trên 5 rãnh).
- `TRANSLATE_DUB`: **Dịch thuật & Lồng tiếng** (phụ đề dịch & giọng lồng tiếng AI **ép khớp chính xác slot thời gian gốc**).
- `SCRIPT_TO_VIDEO`: **Tạo video từ kịch bản** (tự động phân đoạn kịch bản, lồng tiếng AI, sinh ảnh slide và render video hoàn chỉnh).
- `SUMMARY`: **Review phim & Tóm tắt video** (Legacy — đồng bộ giọng đọc review khớp với cảnh phim cắt ghép).

---

# A. MODE MEDIA_COMPOSER — Biên tập Video Đa phương tiện (Flagship)

Pipeline gồm 3 công đoạn tinh gọn và hiệu năng cao:
```
composer.ingest ➔ composer.prepare ➔ composer.render
```

## A.1. Tổng quan các công đoạn

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| `composer.ingest` | ComposerService | Kiểm tra tài nguyên, tự động tính toán auto-arrange timeline 5 rãnh nếu rỗng, xác định `target_duration_sec` |
| `composer.prepare` | MediaService (FFmpeg) | Chuẩn hoá hình ảnh (scale/pad theo aspect ratio `16:9` / `9:16`), chuẩn hoá âm thanh (resample 48kHz stereo), biên dịch file phụ đề ASS UTF-8 Unicode-safe (`\fn`, `\c`, `\fs`) |
| `composer.render` ★ | MediaService (FFmpeg) | Ghép đa lớp visual (Background + Slideshow 1.05x), lặp vô tận BGM (`aloop`), dynamic sidechain ducking (-12dB), burn-in phụ đề ASS, xuất video MP4 1080p |

## A.2. Chi tiết thực thi từng công đoạn

### 1. `composer.ingest`
- **Kiểm tra tài nguyên (Asset Validation)**: Truy vấn danh sách `assets` liên kết với dự án (ảnh minh họa, file BGM, file audio thuyết minh).
- **Auto-arrange Timeline**: Nếu timeline chưa có clip nào (`timeline_clips` rỗng), tự động kích hoạt thuật toán sắp xếp timeline:
  - Phân bổ các clip ảnh tuần tự vào rãnh `MAIN_VIDEO`.
  - Phân bổ clip âm thanh thuyết minh vào rãnh `VOICE`.
  - Phân bổ bài nhạc nền vào rãnh `BGM`.
- **Tính toán thời lượng (`target_duration_sec`)**: Xác định tổng thời lượng video dựa trên điểm kết thúc lớn nhất của các clip trên timeline.

### 2. `composer.prepare`
- **Chuẩn hóa tỷ lệ hình ảnh**:
  - Đọc tỷ lệ cấu hình của dự án (`16:9` hoặc `9:16`).
  - Áp dụng bộ lọc scale & pad để ảnh hiển thị vừa vặn, không bị méo tỷ lệ, bổ sung viền đệm letterbox/pillarbox hoặc nền làm mờ tự nhiên.
- **Chuẩn hóa luồng âm thanh**:
  - Chuyển đổi toàn bộ các tệp âm thanh (giọng đọc, hiệu ứng, nhạc nền) về chuẩn âm thanh thống nhất: PCM 48kHz stereo WAV.
- **Biên dịch phụ đề ASS (`subtitles.ass`)**:
  - Trích xuất phụ đề từ timeline hoặc từ kết quả OCR / Dịch thuật của các asset.
  - Sinh tệp phụ đề Advanced SubStation Alpha (ASS) chuẩn UTF-8 Unicode-safe:
    - Font chữ: Arial / Noto Sans tương thích hoàn toàn tiếng Việt có dấu.
    - Định vị: Neo chính xác ở đáy khung hình (`\an2`), có viền tương phản chống chói chữ.

### 3. `composer.render`
- **Filtergraph Ghép Đa Lớp (Visual Composition)**:
  - *Layer Background*: Ảnh hoặc video nền mở rộng toàn màn hình kèm hiệu ứng làm mờ nhẹ (`boxblur`).
  - *Layer Main Slideshow*: Các ảnh slide nối tiếp nhau, áp dụng hiệu ứng chuyển động zoom nhẹ 1.05x (`zoompan`) mang lại cảm giác sống động.
  - *Layer Overlay*: Các thành phần nhãn, sticker hoặc watermark được căn giữa/neo góc theo toạ độ.
- **Xử lý Âm thanh Đa rãnh (Audio Composition)**:
  - *Track VOICE*: Giọng đọc thuyết minh phát tại đúng timestamp cấu hình.
  - *Track BGM*: Nhạc nền được lặp vô tận phủ kín toàn bộ thời lượng video bằng bộ lọc `aloop=loop=-1:size=2e+09`.
  - *Dynamic Sidechain Ducking*: Bộ lọc `sidechaincompress=threshold=0.03:ratio=6:attack=50:release=300:volume=0.25` tự động hạ âm lượng BGM xuống -12dB ngay khi có tiếng nói và đẩy âm lượng hồi phục mượt mà khi người đọc ngắt câu.
- **Burn-in Phụ đề ASS & Đóng gói Video**:
  - Burn trực tiếp tệp phụ đề ASS vào luồng hình ảnh bằng filter `ass=...`.
  - Kết xuất MP4 H.264 (ưu tiên GPU NVENC, tự động fallback về CPU `libx264`).
  - Dùng `ffprobe` đo đạc thông số thực tế, tạo thumbnail đại diện và lưu vào bảng `outputs`.

---

# B. MODE TRANSLATE_DUB — Dịch thuật & Lồng tiếng

Biến video nước ngoài thành bản tiếng Việt: dịch phụ đề theo 1 trong **13 phong cách dịch**, tuỳ chọn lồng tiếng AI ép khớp timestamp gốc và che hardsub gốc.

## B.0. Tổng quan các công đoạn

Pipeline gồm 7 công đoạn:
```
dub.ingest ➔ dub.stt ➔ dub.merge ➔ dub.translate ➔ dub.mask ➔ dub.ttsAlign ➔ dub.render
```

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| `dub.ingest` | Media (FFmpeg) | Demux video/audio, chuẩn hoá âm lượng LUFS -16dB |
| `dub.stt` | AsrProvider (Whisper) | `transcript_segments` kèm timestamp câu thoại |
| `dub.merge` | Core | Kiểm tra dữ liệu: transcript, translation, duration, language |
| `dub.translate` | LLMProvider + 13 StylePresets | Bản dịch câu thoại theo phong cách |
| `dub.mask` | Vision / User Masks | Bounding box che hardsub (`ocr_regions` APPROVED) |
| `dub.ttsAlign` ★ | TtsProvider + ForcedAlignService | Audio lồng tiếng ép khớp slot gốc (khi bật dubbing) |
| `dub.render` | Media (FFmpeg) | Burn mask APPROVED + Burn sub mới + Sidechain Ducking + NVENC |

> **Lưu ý Kiến trúc:** Pipeline `TRANSLATE_DUB` là **STT-only**, loại bỏ OCR nhận diện chữ để tăng tốc độ và độ tin cậy. Phụ đề dịch mới được burn mặc định ở đáy khung hình (`\an2`).

## B.1. Chi tiết thực thi từng công đoạn

### 1. `dub.ingest`
- Nhận video từ resumable upload chunk 8MB (giới hạn 2GB).
- Demux tách luồng audio riêng (WAV 16kHz mono) và luồng video gốc.
- Chuẩn hóa âm lượng audio 2-pass bằng bộ lọc `loudnorm` (mục tiêu −16 LUFS) để Whisper nhận diện chính xác nhất.

### 2. `dub.stt` (ASR Speech-to-Text)
- **Overlap Stitching (15s)**: File âm thanh dài được chia thành các chunk 300s với phần gối đầu 15s. Hàm `dedupeOverlapSegments` khử lặp thông minh các câu tại biên chunk, ghép timestamp chuẩn xác toàn bộ video.
- **Lọc ảo giác Whisper**: `filterHallucinatedSegments` tự động loại bỏ các đoạn lặp từ bất thường do model sinh ra khi gặp đoạn nhạc hoặc im lặng (`[Music]`, `♪♪`).
- **Canonical Cache**: Hash nội dung file audio stream (`hashFileContent`) kết hợp cấu hình Whisper để tra cứu cache, chống gọi lại API tốn kém.

### 3. `dub.merge`
- Kiểm tra tính toàn vẹn của transcript trong DB trước khi chuyển sang bước dịch.

### 4. `dub.translate` (Dịch thuật LLM theo 13 StylePresets)
- **13 Phong cách dịch thuật (`StylePreset`)**:
  `co-trang`, `bat-trend`, `review-phim`, `tinh-cam`, `tai-lieu`, `hai-huoc`, `chinh-luan`, `gaming`, `kinh-di`, `the-thao`, `cong-nghe`, `tre-em`, `sat-nghia`.
- **Chiến lược dịch 3 vòng (TransFlow)**:
  - *Vòng 1 (Parallel Batch)*: Gom nhóm các câu và dịch song song với giới hạn concurrency.
  - *Vòng 2 (Rescue Batch)*: Thu thập các câu còn thiếu hoặc bị lỗi format, gom nhóm nhỏ 5 câu để dịch lại.
  - *Vòng 3 (Single-Line Fallback)*: Dịch riêng từng câu còn sót cuối cùng, đảm bảo không bỏ sót bất kỳ câu nào.
- **Kiểm soát rò rỉ CJK**: Chặn model LLM chép nguyên văn chữ Hán/Trung đối với bản dịch tiếng Việt.
- **Tự động sửa lỗi ngữ nghĩa (`repairTranslationWithLlm`)**: Tự động gọi LLM sửa lỗi ngữ nghĩa nếu câu dịch vi phạm semantic gate.

### 5. `dub.mask` (Che Hardsub Gốc)
- Lấy mẫu tối đa 8 frame trên toàn bộ video (`planMaskFrames`).
- Gọi Vision provider phát hiện các vùng chứa hardsub.
- Hàm `filterSubtitleBoxes` loại bỏ logo góc và giữ lại các vùng chữ phụ đề ở nửa dưới khung hình.
- Hợp nhất thành 1 vùng che tĩnh xuyên suốt video, lưu vào bảng `ocr_regions` với `source = 'AUTO'`, `status = 'APPROVED'`, `is_static = 1`.
- Hỗ trợ người dùng vẽ thêm hoặc chỉnh sửa mask thủ công qua `MaskEditor.jsx`.

### 6. `dub.ttsAlign` (Lồng tiếng AI & Forced Alignment)
Chỉ chạy khi người dùng bật `enableDubbing = true`:
- Sinh giọng đọc cho từng câu dịch qua TTS provider đã chọn.
- **Forced Alignment Timing**:
  - `TEMPO_MAX = 1.35`: Tốc độ co dãn tối đa chặn ở 1.35x để giữ pitch tự nhiên, không biến giọng đọc thành sóc chuột.
  - **Pause-expansion**: Dòng phụ đề sở hữu slot của nó + khoảng lặng (pause) trước câu tiếp theo (chừa buffer 60ms an toàn): `roomDur = Math.max(slotDur, nextStart - 0.06 - startSec)`. Nếu thời lượng giọng đọc nằm gọn trong `roomDur`, giữ nguyên tốc độ 1.0x tự nhiên mà không cần time-stretch hay rút gọn câu.
  - **Silence trimming**: Dùng FFmpeg `silenceremove` cắt 100-300ms im lặng thừa trước và sau câu thoại.
  - **Fade-out**: Thêm `afade=t=out:d=0.12` ở đuôi audio clip khi buộc phải cắt ngắn.

### 7. `dub.render`
- **Mask & Subtitle Validation**: Chỉ nạp các mask có `status = 'APPROVED'`. Báo lỗi rõ ràng `BLOCK_RENDER: MASK_DATA_UNAVAILABLE` nếu truy vấn DB lỗi hoặc `BLOCK_RENDER: MASK_INVALID` nếu toạ độ sai lệch.
- **Lớp che Subtitle**: Áp dụng filter `boxblur` (với type `blur`) hoặc `drawbox` (với type `solid`) lên vùng mask `APPROVED`.
- **Burn-in Phụ đề mới**: Phụ đề ASS dịch được burn đè ở đáy khung hình (`\an2`), luôn hiển thị nổi trên lớp che.
- **Dynamic Sidechain Ducking**: Nén nhạc nền gốc -12dB khi có giọng lồng tiếng và hồi phục âm lượng đầy đủ khi ngắt nghỉ giữa các câu thoại.
- **Kết xuất**: Đóng gói video và audio mới thành MP4 (ưu tiên tăng tốc phần cứng NVENC).

---

# C. MODE SCRIPT_TO_VIDEO — Tạo video từ kịch bản

Biến một kịch bản văn bản thô thành video hoàn chỉnh có thuyết minh AI, ảnh slide minh hoạ và phụ đề.

## C.0. Tổng quan các công đoạn

Pipeline gồm 7 công đoạn:
```
script.ingest ➔ script.analyze ➔ script.tts ➔ script.image ➔ script.align ➔ script.subtitle ➔ script.render
```

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| `script.ingest` | Core | Chuẩn hoá văn bản, kiểm tra băm SHA-256, lưu `script/source.txt` |
| `script.analyze` | LLMProvider (Gemini/OpenAI) | `script_segments` (lời đọc + visual prompt) |
| `Review Gate` ★ | Hệ thống / Người dùng | Tạm dừng để user duyệt/sửa kịch bản (`script_review_required = 1`) |
| `script.tts` | TtsProvider | File audio thuyết minh cho từng phân đoạn |
| `script.image` | SlideImage / ImageProvider | Hình ảnh slide minh họa cho từng phân đoạn |
| `script.align` | Core | `timeline_clips` căn thời lượng ảnh khớp chính xác với giọng đọc |
| `script.subtitle` | Core / Media | Phụ đề ASS/SRT đồng bộ giọng đọc |
| `script.render` | Media (FFmpeg) | Video MP4 hoàn chỉnh kết hợp ảnh, voice, nhạc nền và phụ đề |

## C.1. Chi tiết thực thi từng công đoạn

### 1. `script.ingest`
- Nhận tệp kịch bản `.txt` hoặc nội dung văn bản.
- Chuẩn hóa ngắt dòng, loại bỏ ký tự lạ, tính toán số ký tự và băm SHA-256 (`script_hash`).
- Lưu bản sao chuẩn tại `storage/projects/:id/script/source.txt` và cập nhật `script_version`.

### 2. `script.analyze` (Phân đoạn kịch bản)
- Chia kịch bản thành các khối văn bản vừa vặn với context window.
- Gửi tới LLM với `SEGMENTATION_SYSTEM_PROMPT` để tách thành các `script_segments`:
  - `narration`: Lời đọc thuyết minh nguyên văn (không được tự ý cắt xén hay thay đổi nội dung).
  - `visual_prompt`: Mô tả hình ảnh tương ứng cho phân đoạn đó.
- Nếu LLM không trả JSON hợp lệ, tự động chuyển sang cơ chế phân đoạn xác định (`deterministicSegments`) dựa theo cấu trúc đoạn văn và dấu câu.
- **Review Gate**: Nếu cấu hình yêu cầu duyệt (`parkAfterAnalysis = true`), pipeline tạm dừng tại đây, đặt trạng thái project là `queued` và `script_review_required = 1` để người dùng vào xem trước và tinh chỉnh kịch bản.

### 3. `script.tts` (Sinh giọng đọc AI)
- Gọi nhà cung cấp TTS đã chọn để tổng hợp giọng đọc cho từng phân đoạn kịch bản.
- Lưu tệp âm thanh vào bảng `audios` và liên kết `voice_audio_id` vào `script_segments`.

### 4. `script.image` (Tạo ảnh slide minh họa)
- Sử dụng `slideImage.js` (hoặc Image Provider) tạo ảnh slide minh họa trực quan theo tỷ lệ khung hình đã chọn (`16:9` hoặc `9:16`).
- Lưu ảnh vào bảng `assets`.

### 5. `script.align` (Căn chỉnh thời lượng)
- Đo đạc thời lượng chính xác của tệp âm thanh thuyết minh từng phân đoạn.
- Tạo các `timeline_clips` với thời lượng khớp chính xác với âm thanh.

### 6. `script.subtitle` & `script.render`
- Sinh tệp phụ đề ASS đồng bộ mốc thời gian.
- FFmpeg ghép các hình ảnh slide, lồng ghép âm thanh thuyết minh, bổ sung nhạc nền nhẹ nhàng và burn-in phụ đề thành tệp MP4 chất lượng cao.

---

# D. MODE SUMMARY — Review phim & Tóm tắt video (Legacy)

Pipeline gồm 8 công đoạn tuần tự:
```
summary.transcribe ➔ summary.sceneDetect ➔ summary.analyze ➔ summary.script ➔ summary.align ➔ summary.tts ➔ summary.subtitle ➔ summary.render
```

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| `summary.transcribe` | AsrProvider (Whisper) | Tệp `transcript.json` có timestamp từng từ/câu |
| `summary.sceneDetect` | Media (FFmpeg) | Danh sách `Scene[]` (startSec, endSec, thumbnailKey) |
| `summary.analyze` | VisionProvider (Gemini) | Mô tả ngữ nghĩa nội dung từng cảnh quay |
| `summary.script` | LLMProvider (Gemini/OpenAI) | `ScriptSegment[]` (lời review + tham chiếu cảnh `sceneRefs`) |
| `summary.align` ★ | AlignService (core) | `TimelineClip[]` khớp thời lượng chính xác (< 1s) |
| `summary.tts` | TtsProvider (Edge/Google/ElevenLabs) | File `Audio` giọng đọc review |
| `summary.subtitle` | Media / Core | Phụ đề ASS/SRT đồng bộ với giọng đọc |
| `summary.render` | Media (FFmpeg) | Video hoàn chỉnh 20–30 phút |

### Chi tiết thực thi:
1. **`summary.transcribe`**: Tách audio 16kHz mono, chia chunk và gọi ASR Whisper nhận dạng toàn bộ lời thoại phim kèm mốc thời gian.
2. **`summary.sceneDetect`**: FFmpeg thực hiện shot detection cắt video thành các cảnh độc lập, xuất thumbnail đại diện cho từng cảnh.
3. **`summary.analyze`**: Trích xuất keyframe của các cảnh tiêu biểu, gửi tới Gemini Vision để nhận diện bối cảnh, nhân vật và hành động.
4. **`summary.script`**: Gửi tóm tắt transcript và danh sách mô tả cảnh cho LLM. LLM sinh kịch bản review có cấu trúc JSON, phân bổ `sceneRefs` phù hợp cho từng đoạn lời bình (`narration`).
5. **`summary.align` (Đồng bộ Giọng ↔ Cảnh)**:
   - Đo thời lượng chính xác `durationSec` của lời review bằng TTS.
   - Gói các cảnh quay trong `sceneRefs` sao cho tổng thời lượng các cảnh bằng đúng thời lượng lời bình (dung sai ±8%, điều chỉnh tốc độ clip trong khoảng 0.9x–1.1x nếu cần).
   - Tạo danh sách `TimelineClip[]` có điểm in/out và hiệu ứng chuyển cảnh `cross` (0.3s).
6. **`summary.tts` & `summary.subtitle`**: Lưu trữ tệp âm thanh thuyết minh và sinh phụ đề bám sát giọng đọc.
7. **`summary.render`**: FFmpeg transcode các cảnh thành mezzanine, ghép nối theo timeline, hòa trộn giọng đọc với nhạc nền (ducking) và render video MP4 1080p.

---

# E. So sánh Bốn Chế độ Sản xuất

| Tiêu chí | `MEDIA_COMPOSER` (Flagship) | `TRANSLATE_DUB` | `SCRIPT_TO_VIDEO` | `SUMMARY` (Legacy) |
| --- | --- | --- | --- | --- |
| **Đầu vào** | Nhiều ảnh, audio, bgm tải lên | 1 video nước ngoài (≤ 2GB) | 1 tệp kịch bản văn bản (.txt) | 1 phim / video dài (2–3h) |
| **Trọng tâm AI** | OCR Vision + Dịch thuật + TTS lồng tiếng | ASR + LLM dịch 13 preset + TTS dubbing | LLM phân đoạn + TTS thuyết minh + SlideImage | ASR + Vision + LLM kịch bản + TTS |
| **Cấu trúc dựng** | Multi-track Timeline 5 rãnh độc lập | Render theo timeline video gốc có mask | Align thời lượng ảnh slide ↔ giọng đọc | Align giọng review ↔ cảnh cắt ghép |
| **Căn chỉnh đồng bộ** | Cắt xén hai đầu (Dual-handle trim) + Snap | Forced Align giọng dub ↔ slot thời gian gốc | Ghép ảnh theo thời lượng audio từng câu | Ghép cảnh phim theo thời lượng câu review |
| **Xử lý hình ảnh** | Scale/Pad aspect ratio, zoom 1.05x, overlay | Giữ hình gốc, che hardsub cũ bằng mask | Sinh ảnh slide minh họa mới hoàn toàn | Cắt dựng cảnh mới từ phim gốc |
| **Độ dài đầu ra** | Tự do theo timeline biên tập | Bằng đúng thời lượng video gốc | Tuỳ thuộc độ dài kịch bản (~1–10 phút) | 20–30 phút |

---

# F. Cơ chế Thử lại (Retry Policy) & Xử lý Huỷ bỏ

1. **Phân loại lỗi**:
   - **Validation Error (`TRANSLATE_NEEDS_REVIEW`, `BLOCK_RENDER`)**: Lỗi dữ liệu — dừng ngay lập tức, không retry; user sửa tay rồi nhấn Regenerate.
   - **Transient Error (503, timeout)**: Retry tự động theo số lần cho phép (2–3 lần) với exponential backoff.
   - **Rate Limit / Quota Exceeded (429)**: Trích xuất `Retry-After`, đặt trạng thái `queued` và lên lịch chạy lại tại `next_retry_at`.
2. **Graceful Cancellation (`POST /projects/:id/cancel`)**:
   - Gửi tín hiệu ngắt qua `AbortController`.
   - Stage đang chạy được hủy an toàn, project chuyển sang trạng thái `cancelled`.
   - File tạm thời trong thư mục `tmp` được thu hồi ngay lập tức.
