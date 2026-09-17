# 07 — Module FFmpeg (packages/media) [PARTIAL — CURRENT là `backend/src/media/ffmpeg.js` + `backend/src/media/mediaService.js` JS, không `packages/media` TS]

Gói `media` đóng gói mọi thao tác FFmpeg thành hàm TypeScript an toàn, dùng chung bởi cả 2 mode.
Mục tiêu: backend không gọi lệnh ffmpeg thô, mà qua interface `MediaService`.

# Current Implementation (CURRENT)

- [CURRENT] `resolveBin`: `FFMPEG_PATH`→PATH→`C:\ffmpeg\bin`→bare name (`backend/src/media/ffmpeg.js:13-52`).
- [CURRENT] `enqueue()` serialize mọi ffmpeg/ffprobe vì build Windows crash exit -22 khi 2 tiến trình ghi file đồng thời (`backend/src/media/ffmpeg.js:123-136`).
- [CURRENT] NVENC `p4`/`cq23` else libx264 `veryfast`/`crf20` chỉ ở `burnSubtitlesStyled` qua `encodeArgs()`; các helper khác hardcode x264; `muxStream` dùng `-c:v copy` (`backend/src/media/mediaService.js:366-375,450-503`).
- [CURRENT] Timeout stage 15/30m (`backend/src/pipeline/runner.js:321-327`) + `BURN 20m` + `DUB_TRACK 15m` (`backend/src/pipeline/stages/dubRender.js:20-21`); `SIGTERM`→`SIGKILL` 5s trong `runBin` (`backend/src/media/ffmpeg.js:54-91`).
- [CURRENT] ASS `\pos` từ `ocr_regions` ratios (`original`/`top`/`bottom`/`custom`) qua `loadSubtitleRegions`/`buildAss` (`backend/src/pipeline/stages/dubRender.js:199-279`).
- [CURRENT] Fallback loudnorm→raw (`dubIngest.js:34-38`).
- [NOT IMPLEMENTED] `maskRegions()` (`blur`/`fill`/`delogo`/`inpaint`) + `maskStrength`/`between(t)`: không hàm nào trong `mediaService.js`; DB `ocr_regions` đã có `mask_strength`/`is_static` (`backend/src/db/schema.js:286-300`) nhưng chưa có consumer.
- [PARTIAL] `signal` + `CANCELLED_BY_USER` + cleanup partial: `runBin`/`ffmpeg()` hỗ trợ `signal` (`ffmpeg.js:54-81,133-135`) nhưng `mediaService.js` hầu hết không nhận `signal`; abort hiện chỉ ở biên stage (`if (signal?.aborted) throw new Error('Cancelled')`, vd `dubRender.js:30`, `dubIngest.js:16`), error là `'Cancelled'` chung, không mã `CANCELLED_BY_USER`, không xoá output dở dang tập trung.
- [NOT IMPLEMENTED] Inpaint FFmpeg-native: cần external provider (Vision/inpainting), ffmpeg chỉ composite.

> Mọi khối TS `export interface MediaService` + chữ ký có `signal`/`maskRegions` phía dưới là [TARGET]; chỉ các đoạn gắn [CURRENT]/[PARTIAL]/[NOT IMPLEMENTED] mới phản ánh code main.

---

## 1. API chính [TARGET]

> [TARGET] — Khối interface dưới là thiết kế (TS `packages/media`). [CURRENT] là các hàm JS rời trong `backend/src/media/mediaService.js` (`probe`, `extractAudio`, `burnSubtitlesStyled`, `buildDubTrack`, `muxStream`...). [NOT IMPLEMENTED] `maskRegions`; [PARTIAL] `signal` (xem `# Current Implementation`).

```ts
export interface MediaService {
  probe(file: string): Promise<MediaInfo>;          // duration, streams, fps, size
  extractAudio(src: string, out: string): Promise<void>;
  detectScenes(src: string): Promise<Scene[]>;       // shot detection
  transcodeToMezzanine(src: string, out: string): Promise<void>;
  applySpeed(inFile: string, out: string, speed: number): Promise<void>;
  applyGrade(inFile: string, out: string, grade: ColorGrade): Promise<void>;
  applyMotion(inFile: string, out: string, m: Motion): Promise<void>; // ken-burns
  concatClips(clips: ConcatInput[], out: string, opts: ConcatOpts): Promise<void>;
  addSubtitles(inFile: string, sub: string, out: string): Promise<void>;
  mixAudio(inVideo: string, voice: string, music: string|null, out: string): Promise<void>;
  addIntroOutro(main: string, intro: string, outro: string, out: string): Promise<void>;
  makeThumbnail(inFile: string, atSec: number, out: string): Promise<void>;

  // === TRANSLATE_DUB ===
  sampleFrames(src: string, fps: 1|2, outDir: string): Promise<Frame[]>;
  normalizeLoudness(inFile: string, out: string, targetLufs?: number): Promise<void>; // mặc định -16
  // MaskRegion: { startSec, endSec, ratioX, ratioY, ratioW, ratioH, maskStrength, isStatic? }
  // pixel được tính từ ratio × videoDims tại runtime (scale-invariant).
  maskRegions(inFile: string, regions: MaskRegion[], method: 'blur'|'fill'|'delogo', out: string, opts?: { videoDims?: {width:number;height:number} }): Promise<void>;
  burnSubtitlesStyled(inFile: string, assFile: string, out: string): Promise<void>;
  mixDubAudio(video: string, dubVoice: string|null, background: string|null, out: string): Promise<void>;
  muxStream(inVideo: string, inAudio: string, out: string, format?: 'mp4'|'mkv'): Promise<void>;
}
```

---

## 2. Chi tiết implementation

### 2.1. probe
`ffprobe -v quiet -print_format json -show_format -show_streams` → parse JSON.

### 2.2. extractAudio
`ffmpeg -i src -vn -ac 1 -ar 16000 out.wav` (chuẩn ASR).

### 2.3. detectScenes
Dùng `select='gt(scene,0.4)'` + `showinfo`, hoặc gọi PySceneDetect nếu có.
Trả `Scene[] { startSec, endSec, thumbnailKey }`.

### 2.4. transcodeToMezzanine
`ffmpeg -i src -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p out.mp4`
(Nhanh cho concat, chất lượng đủ).

### 2.5. applySpeed (cho align)
Video: `-filter:v "setpts=PTS/${speed}"`.
Audio kèm: `-filter:a "atempo(${speed})"` (atempo giới hạn 0.5–2.0; ghép nếu cần).
Speed nằm [0.9, 1.1] theo thiết kế align → an toàn.

### 2.6. applyGrade (chỉnh màu)
`-vf "eq=contrast=${c}:saturation=${s}, colorbalance=..."` hoặc áp LUT:
`-vf "lut3d=file=teal-orange.cube"`.

### 2.7. applyMotion (ken-burns)
`-vf "zoompan=z='min(zoom+0.002,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"`.

### 2.8. concatClips (SUMMARY)
- Mỗi clip đã transcode → `concat demuxer` (`filelist.txt`).
- Transition: với `cross`, render clip A kết thúc + clip B bắt đầu chồng 0.3s qua `xfade`:
  `filter_complex "[0][1]xfade=transition=fade:duration=0.3:offset=..."`.
- Thứ tự `startAtSec` đã tính overlap → giọng không lệch.

### 2.9. mixAudio (voice + music)
- Voice chính, music nền duck `-filter_complex "[1]volume=0.2[music];[0][music]amix=inputs=2"`.
- Chuẩn hoá: `-af loudnorm=I=-16:TP=-1.5:LRA=11`.

### 2.10. addSubtitles
Burn-in: `-vf "subtitles=sub.srt"`. Hoặc mux sidecar (`-c:s mov_text`).

### 2.11. sampleFrames (TRANSLATE_DUB)
`ffmpeg -i src -vf fps=2 -q:v 2 out/frame_%05d.jpg` — trích 1–2 fps cho OCR.
Chỉ decode video stream (`-an`) để tiết kiệm CPU.

### 2.12. normalizeLoudness (TRANSLATE_DUB)
Hai pass chuẩn EBU R128: đo rồi áp
`-af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json`. Audio đầu vào chuẩn LUFS giúp STT
và TTS mixing ổn định hơn.

### 2.13. maskRegions (TRANSLATE_DUB) ★ [NOT IMPLEMENTED]

> [NOT IMPLEMENTED] — Không có `maskRegions()` trong `backend/src/media/mediaService.js` (grep toàn `backend/src/media` rỗng). Bảng `ocr_regions` đã có `mask_strength`/`is_static` + ratios (`backend/src/db/schema.js:286-300`) nhưng chưa có consumer; `between(t)`/`boxblur`/`drawbox`/`delogo` dưới đây là [TARGET].
Che vùng hardsub theo từng `OcrRegion { startSec, endSec, ratioX, ratioY, ratioW, ratioH, maskStrength, isStatic? }`;
pixel được tính `x = round(ratioX * vw)`, ... từ `videoDims`, chỉ bật filter trong khoảng thời gian đó:

| Method | Filter |
| --- | --- |
| `blur` | `boxblur=luma_radius=<R>` áp trên vùng crop bbox, overlay trả về — `R = clamp(round(maskStrength * min(bw,bh) / 4), 1, ...)` |
| `fill` | `drawbox=x:y:w:h:color=<nền>@<op>:t=fill` — `op = 0.4 + maskStrength*0.6`, màu nền lấy từ **background color sampling** quanh bbox (tránh vệt chữ lem còn sót khi blur) |
| `delogo` | `delogo=x:y:w:h` — nội suy từ biên, tốt cho nền tĩnh (dùng làm xấp xỉ `inpaint` khi chưa có model AI offline) |

`maskStrength` (0–1) là **1 tham số duy nhất** điều khiển cả bán kính blur và độ đục lớp phủ — khớp
với thanh kéo "độ mờ" trên `SubRegionEditor` (xem `04` §4.1). `isStatic=true` → mở rộng
`enable='between(t,0,duration)'` cho toàn bộ video.

AI inpainting (`method='inpaint'`) không chạy bằng ffmpeg: VisionProvider sinh frame đã lấp chữ,
ffmpeg chỉ composite lại vào timeline gốc. ⚠️ `inpaint` là **tùy chọn nâng cao (premium)** — gọi thêm
Vision/Inpainting Provider, render lâu hơn và tốn chi phí API; `blur`/`fill` là mặc định nhanh nhẹ.

> [NOT IMPLEMENTED] — `inpaint` KHÔNG phải FFmpeg-native, cần external provider; hiện chưa có pipeline nào cài đặt (xem `# Current Implementation`).

### 2.14. burnSubtitlesStyled (TRANSLATE_DUB) [CURRENT]

> [CURRENT] — `burnSubtitlesStyled` dùng `encodeArgs()` (NVENC `p4`/`cq23` else x264 `veryfast`/`crf20`) + ASS `\pos` từ ratios (`backend/src/media/mediaService.js:366-375`, `dubRender.js:231-279`).
Burn file **ASS** (không phải SRT) vì cần `\pos` định vị theo vùng mask: mặc định đè lên vị trí bbox
cũ (tính từ `ratioX/Y/W/H` × `videoDims`), hoặc theo `subPosition` (`original`/`top`/`bottom`/`custom`)
user chọn (xem `01` §3.2) + font/outline:
`-vf "ass=subs.ass"` — giữ nguyên timing `[startSec, endSec]` của TranscriptSegment.

### 2.15. mixDubAudio & muxStream (TRANSLATE_DUB) [CURRENT]

> [CURRENT] — `muxStream` là `-c:v copy` (không re-encode, không NVENC) + `-c:a aac 192k` (`mediaService.js:450-462`); `buildDubTrack` amix + ducking ×0.25 + `loudnorm` (`mediaService.js:391-447`). Câu "Mux cuối: `-c:v h264_nvenc -preset p4`..." dưới đây là [TARGET] (chỉ đúng cho `burnSubtitlesStyled`/`encodeVideo`).

- **Audio dub timing handling** (xem `05_THIET_KE_PIPELINE_CHI_TIET.md` §B.5 chi tiết):
  - **Timing lệch lớn (>20%)**: MediaJob → `FAILED`, thông báo user cần rerun.
  - **Timing lệch nhỏ (5-20%)**: time-stretch audio dub ±20% cho khớp slot (atempo 0.8–1.2).
  - **Timing khớp (±20%)**: giữ nguyên audio dub thực tế.
  - `tts_audio_ref` là source of truth cho audio đã dub (KHÔNG dùng `dub_track_asset_id`).
- Dubbing bật: thay voice gốc bằng dub track; nếu có background stem (nhạc/tiếng động môi trường)
  thì `amix` với ducking −12dB, kết thúc bằng `loudnorm`.
- Dubbing tắt: copy audio gốc (`-c:a copy`).
- Mux cuối: `-c:v h264_nvenc -preset p4` nếu có GPU NVIDIA (tăng tốc phần cứng), fallback
  `libx264 -preset medium`; container MP4 hoặc MKV theo tuỳ chọn.

### 2.16. Subtitle presentation options (TRANSLATE_DUB)

User chọn trước render, lưu trong `Project.params`:

| Option | Giá trị mặc định | Mô tả |
| --- | --- | --- |
| `target_font` | `Arial` | Font-family từ danh sách có sẵn |
| `target_font_size` | `22` | Font size (16–48px) |
| `target_opacity` | `1.0` | Đopacity (0.5–1.0) |
| `target_color` | `#FFFFFF` | Font color hex |
| `subtitle_position` | `BOTTOM` | Vị trí phụ đề (`TOP`/`MIDDLE`/`BOTTOM`/`CUSTOM`) |
| `hard_sub_enabled` | `true` | Burn subtitle vào video (mặc định cho TRANSLATE_ONLY) |

### 2.17. Render validation

Sau khi render xong, kiểm tra output:

1. **FFmpeg probe**: Kiểm tra file không bị corrupt (có video/audio stream đầy đủ).
2. **Duration check**: Output duration ±2s so với duration gốc.
3. **Resolution check**: Output resolution khớp config (1080p mặc định).
4. **Audio check**: Audio stream tồn tại, sample rate ≥ 44100Hz.
5. Nếu render fail → retry 1 lần (FFmpeg có thể do transient), sau đó `FAILED`.

---

## 3. Worker & tài nguyên

- Render chạy trong **BullMQ worker riêng** (không block API).
- Tách worker **CPU** (ffmpeg: demux, mask, burn-in, mux) và worker **GPU/AI** (ASR, OCR, TTS,
  inpainting) — render nặng không tranh chấp VRAM với inference (xem `08_TRIEN_KHAI_VA_VAN_HANH.md`).
- Giới hạn concurrent render (semaphore) theo CPU/RAM; video dài chia chunk song song.
- File trung gian lưu `storage/tmp`, dọn sau khi xuất hoặc theo retention policy (`Project.expiresAt`,
  xem `08` §6 và `02` §5).

### 3.1. Huỷ tiến trình FFmpeg giữa chừng (Cancel) [PARTIAL]

> [PARTIAL] — `runBin`/`ffmpeg()` đã hỗ trợ `signal` + `SIGTERM`→`SIGKILL` 5s + `timeout` (`backend/src/media/ffmpeg.js:54-91,133-135`). Nhưng `mediaService.js` hầu hết không nhận `signal` (chỉ `burnSubtitlesStyled`/`buildDubTrack` nhận `timeout`); abort hiện chỉ ở biên stage (`signal?.aborted → throw 'Cancelled'`), không mã `CANCELLED_BY_USER`, không cleanup partial tập trung. Chữ ký `signal?` + `CANCELLED_BY_USER` dưới đây là [TARGET].

Mọi hàm `MediaService` chạy lâu (render, concat, mask, burn-in) nhận thêm tham số tuỳ chọn
`signal?: AbortSignal`:

```ts
concatClips(clips: ConcatInput[], out: string, opts: ConcatOpts, signal?: AbortSignal): Promise<void>;
```

- Khi worker nhận tín hiệu huỷ (từ `CancelProjectUseCase`, xem `03` §3 và `01` §5.2), `AbortController`
  tương ứng được `abort()`; wrapper FFmpeg lắng nghe sự kiện này và gọi `child_process.kill('SIGTERM')`
  lên tiến trình `ffmpeg` con, sau đó `SIGKILL` nếu không thoát trong 5s.
- File output dở dang bị xoá ngay; `GenerationJob.status = FAILED`, `error = 'CANCELLED_BY_USER'`.
- Vì FFmpeg không hỗ trợ resume giữa chừng một lệnh đơn, huỷ luôn đồng nghĩa phải chạy lại từ đầu
  stage đó nếu user muốn tiếp tục sau này (khác với upload resumable ở tầng ingest).

---

## 4. Quyết định media

| Quyết định | Lý do |
| --- | --- |
| Mezzanine trước concat | concat nhanh, tránh re-encode lặp |
| speed qua setpts/atempo | align chính xác, giữ đồng bộ |
| xfade cho transition | mượt, không nhảy hình |
| `fill` màu nền sampling là mặc định che chữ | blur để lại vệt chữ lem; inpaint đẹp nhưng đắt GPU |
| Mask theo `enable='between(t,...)'` | chỉ xử lý đúng đoạn có hardsub, không đè toàn video |
| Burn-in bằng ASS thay SRT | cần `\pos` khớp bbox cũ + style chữ nhất quán |
| NVENC ưu tiên khi mux | render 1080p/4K nhanh gấp nhiều lần so với libx264 CPU |
| `AbortSignal` xuyên suốt `MediaService` | Cho phép huỷ job render giữa chừng an toàn (FR-J1), giải phóng CPU/GPU ngay thay vì chờ hết pipeline |
