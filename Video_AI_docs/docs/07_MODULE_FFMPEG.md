# 07 — Module FFmpeg (`backend/src/media/`)

> Triển khai hiện tại: `backend/src/media/ffmpeg.js` và `backend/src/media/mediaService.js` (JavaScript ESM).
> Mọi thao tác xử lý video/audio được đóng gói thành các hàm có kiểm tra lỗi an toàn, serialize tiến trình trên Windows và tự động nhận diện tăng tốc phần cứng NVENC.

---

## 1. Cơ chế Cốt lõi & Quản lý Tiến trình (`ffmpeg.js`)

1. **Tìm kiếm & Phân giải Binary (`resolveBin`)**:
   - Ưu tiên biến môi trường `FFMPEG_PATH` trong `.env`
   - Kiểm tra trong `PATH` hệ thống
   - Kiểm tra đường dẫn mặc định trên Windows `C:\ffmpeg\bin`
   - Tự động kiểm tra tính sẵn sàng qua `ffmpegAvailable()` (ghi nhận phiên bản hoặc cảnh báo khi thiếu).
2. **Tuần tự hóa trên Windows (`enqueue`)**:
   - Trên hệ điều hành Windows, việc chạy đồng thời nhiều tiến trình FFmpeg ghi đè file có thể dẫn đến lỗi crash exit `-22`. Hàng đợi `enqueue()` tuần tự hóa các tác vụ FFmpeg nặng để đảm bảo an toàn tuyệt đối.
3. **Quản lý Vòng đời & Timeout**:
   - Hỗ trợ `AbortSignal` và tham số `timeout` cho các tác vụ render lâu.
   - Khi bị huỷ hoặc hết hạn: Gửi tín hiệu `SIGTERM`, nếu tiến trình không thoát sau 5 giây sẽ ép buộc dừng bằng `SIGKILL`.

---

## 2. Các Hàm Xử lý Media (`mediaService.js`)

### 2.1. Thăm dò & Trích xuất Dữ liệu
- **`probe(file)`**: Gọi `ffprobe` trích xuất thông tin kỹ thuật: duration, width, height, fps, bitrate, audio/video streams.
- **`extractAudio(src, out)`**: Tách luồng audio 16kHz mono WAV (`-vn -ac 1 -ar 16000`) phục vụ ASR Whisper.
- **`sliceAudio(src, out, startSec, durSec)`**: Cắt phân đoạn âm thanh theo khoảng thời gian.
- **`sampleFrames(src, outDir, opts)`**: Trích xuất frame hình ảnh (mặc định 2 fps) phục vụ phân tích thị giác.
- **`extractMaskFrames(src, projectDirPath, timestamps, opts)`**: Trích xuất các frame cụ thể tại các timestamp dự kiến để phát hiện hardsub.

### 2.2. Phân đoạn & Dựng Video (SUMMARY & SCRIPT_TO_VIDEO)
- **`detectScenes(src, opts)`**: Shot detection phát hiện các điểm cắt cảnh bằng FFmpeg filter `select='gt(scene,0.4)'`.
- **`makeThumbnail(src, atSec, out)`**: Xuất ảnh thumbnail tại mốc giây xác định.
- **`transcodeToMezzanine(src, out)`**: Chuyển đổi video về định dạng H.264 mezzanine (`veryfast`, CRF 18) giúp quá trình concat không bị lệch keyframe.
- **`clipSlice({ src, inSec, outSec, speed, out })`**: Cắt đoạn clip kèm điều chỉnh tốc độ qua `setpts` và `atempo`.
- **`concatClips(clips, out, opts)`**: Ghép nối các phân đoạn video bằng filter `xfade` (transition duration 0.3s).
- **`applyMotionImage({ src, out, durationSec, ... })`**: Tạo hiệu ứng chuyển động Ken-Burns (zoompan) cho ảnh tĩnh trong video.

### 2.3. Xử lý Âm thanh & Lồng tiếng (TRANSLATE_DUB)
- **`normalizeLoudness(inFile, out, targetLufs = -16)`**: Chuẩn hoá âm lượng chuẩn EBU R128 (`loudnorm=I=-16:TP=-1.5:LRA=11`).
- **`trimAudioSilence(inFile, out)`**: Tự động loại bỏ 100-300ms im lặng thừa trước và sau câu thoại do TTS sinh ra bằng filter `silenceremove`.
- **`applyTempoAudio(inFile, out, { tempo, padBeforeSec, padAfterSec })`**: Co dãn thời lượng audio lồng tiếng (giới hạn `TEMPO_MAX = 1.35`) và chèn khoảng lặng đệm.
- **`buildDubTrack({ originalMedia, entries, out, backgroundVolume, useSidechainDucking, audioMode })`**:
  - Hỗ trợ 3 chế độ âm thanh (`AUDIO_MODES`):
    - `DUB_MIX`: Lồng tiếng AI + giữ nhạc nền gốc có ducking.
    - `DUB_REPLACE`: Thay thế hoàn toàn bằng giọng lồng tiếng mới.
    - `ORIGINAL_ONLY`: Giữ nguyên âm thanh gốc, chỉ thay đổi phụ đề.
  - **Dynamic Sidechain Ducking**: Nén âm lượng nhạc nền gốc -12dB (`sidechaincompress=threshold=0.04:ratio=8:attack=50:release=250`) khi có tiếng thuyết minh và tự động hồi phục 100% âm lượng trong khoảng nghỉ giữa các câu thoại.

### 2.4. Phụ đề & Che Hardsub (Masking)
- **`buildMaskFilter(regions, { width, height })`**:
  - Chuyển đổi các toạ độ tỷ lệ scale-invariant (`ratioX, ratioY, ratioW, ratioH`) thành pixel thực tế.
  - Sinh bộ lọc FFmpeg: Dùng `boxblur` cho vùng che kiểu `blur` và `drawbox` cho vùng che kiểu `solid`.
- **`applySubtitleMasks(inFile, regions, opts)`**: Áp dụng các vùng che hardsub từ danh sách mask `APPROVED`.
- **`burnSubtitlesStyled(inFile, assPath, out, opts)`**:
  - Burn file phụ đề ASS có định dạng kiểu dáng và toạ độ `\pos` neo ở đáy khung hình (`\an2`).
  - Tự động nhận diện NVENC GPU (`h264_nvenc -preset p4 -cq 23`), fallback về CPU `libx264 -preset veryfast -crf 20`.
- **`muxStream(inVideo, inAudio, out, opts)`**: Ghép luồng video và luồng audio thành phẩm bằng `-c:v copy` và `-c:a aac 192k` mà không cần re-encode hình ảnh lần thứ hai.

### 2.5. Xử lý Đa Lớp & Biên tập Đa Phương tiện (MEDIA_COMPOSER)
- **Visual Multi-layer Filtergraph**:
  - *Track BACKGROUND*: Nền video/ảnh được scale kín khung hình, áp dụng `boxblur=luma_radius=min(h\,w)/20:luma_power=1` tạo chiều sâu trường ảnh.
  - *Track MAIN_VIDEO / SLIDESHOW*: Các slide ảnh được scale & pad chuẩn theo tỷ lệ dự án (`16:9` hoặc `9:16`), kết hợp hiệu ứng chuyển động phóng to nhẹ 1.05x (`zoompan`) mượt mà.
  - *Track OVERLAY*: Căn giữa hoặc neo toạ độ các layer nhãn dán, watermark, huy hiệu.
- **Audio Multi-track & Dynamic Ducking**:
  - *BGM Loop*: Lặp vô tận bài nhạc nền với bộ lọc `aloop=loop=-1:size=2e+09` để phủ kín toàn bộ thời lượng video.
  - *Dynamic Sidechain Ducking*: Bộ lọc `sidechaincompress=threshold=0.03:ratio=6:attack=50:release=300:volume=0.25` tự động nén âm lượng nhạc nền BGM xuống -12dB khi có giọng voiceover và hồi phục về mức âm lượng ban đầu khi kết thúc câu nói.
- **Burn-in Phụ đề ASS UTF-8 Unicode-Safe**:
  - Bộ lọc `ass=subtitles.ass` burn trực tiếp phụ đề tiếng Việt có dấu (`\fnArial`, `\c&HFFFFFF&`, `\fs`, `\an2`) bảo đảm hiển thị sắc nét trên mọi thiết bị mà không phụ thuộc font máy khách.

---

## 3. Quy trình Render Hoàn chỉnh theo Chế độ

1. **MEDIA_COMPOSER** (Flagship):
   Chuẩn hoá assets (ảnh, audio) ➔ Dựng filtergraph đa lớp visual (Background blur + Main Slideshow 1.05x + Overlay) ➔ Hòa trộn audio đa rãnh (Voiceover + BGM loop vô tận + Sidechain ducking -12dB) ➔ Burn-in phụ đề ASS UTF-8 ➔ Xuất file MP4 H.264 (NVENC/x264) ➔ Probe thông số và tạo thumbnail.
2. **TRANSLATE_DUB**:
   Nạp mask `APPROVED` ➔ Áp dụng filter làm mờ/che chữ gốc (`applySubtitleMasks`) ➔ Burn phụ đề ASS dịch mới (`burnSubtitlesStyled`) ➔ Tạo dub track âm thanh với ducking (`buildDubTrack`) ➔ Đóng gói mux stream cuối cùng (`muxStream`).
3. **SCRIPT_TO_VIDEO**:
   Chuyển ảnh slide thành video clip có hiệu ứng Ken-Burns ➔ Concat theo thứ tự kịch bản ➔ Ghép âm thanh thuyết minh và nhạc nền ➔ Burn phụ đề ASS ➔ Xuất file MP4.
4. **SUMMARY** (Legacy):
   Transcode cảnh ➔ Ghép concat xfade ➔ Tạo voice track tổng ➔ Hòa trộn nhạc nền ➔ Burn phụ đề ASS ➔ Xuất file MP4.
