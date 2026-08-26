# 07 — Module FFmpeg (packages/media)

Gói `media` đóng gói mọi thao tác FFmpeg thành hàm TypeScript an toàn, dùng chung bởi cả 2 mode.
Mục tiêu: backend không gọi lệnh ffmpeg thô, mà qua interface `MediaService`.

---

## 1. API chính

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
  maskRegions(inFile: string, regions: MaskRegion[], method: 'blur'|'fill'|'delogo', out: string): Promise<void>;
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

### 2.13. maskRegions (TRANSLATE_DUB) ★
Che vùng hardsub theo từng `OcrRegion { startSec, endSec, x, y, w, h }`, chỉ bật filter trong
khoảng thời gian đó:

| Method | Filter |
| --- | --- |
| `blur` | `boxblur=luma_radius=20` áp trên vùng crop bbox, overlay trả về |
| `fill` | `drawbox=x:y:w:h:color=<nền>@1:t=fill` — màu nền lấy từ **background color sampling** quanh bbox (tránh vệt chữ lem còn sót khi blur) |
| `delogo` | `delogo=x:y:w:h` — nội suy từ biên, tốt cho nền tĩnh |

AI inpainting (`method='inpaint'`) không chạy bằng ffmpeg: VisionProvider sinh frame đã lấp chữ,
ffmpeg chỉ composite lại vào timeline gốc.

### 2.14. burnSubtitlesStyled (TRANSLATE_DUB)
Burn file **ASS** (không phải SRT) vì cần `\pos` định vị đúng toạ độ bbox cũ (hoặc vị trí user
chọn) + font/outline:
`-vf "ass=subs.ass"` — giữ nguyên timing `[startSec, endSec]` của TranscriptSegment.

### 2.15. mixDubAudio & muxStream (TRANSLATE_DUB)
- Dubbing bật: thay voice gốc bằng dub track; nếu có background stem (nhạc/tiếng động môi trường)
  thì `amix` với ducking −12dB, kết thúc bằng `loudnorm`.
- Dubbing tắt: copy audio gốc (`-c:a copy`).
- Mux cuối: `-c:v h264_nvenc -preset p4` nếu có GPU NVIDIA (tăng tốc phần cứng), fallback
  `libx264 -preset medium`; container MP4 hoặc MKV theo tuỳ chọn.

---

## 3. Worker & tài nguyên

- Render chạy trong **BullMQ worker riêng** (không block API).
- Tách worker **CPU** (ffmpeg: demux, mask, burn-in, mux) và worker **GPU/AI** (ASR, OCR, TTS,
  inpainting) — render nặng không tranh chấp VRAM với inference (xem `08_TRIEN_KHAI_VA_VAN_HANH.md`).
- Giới hạn concurrent render (semaphore) theo CPU/RAM; video dài chia chunk song song.
- File trung gian lưu `storage/tmp`, dọn sau khi xuất.

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
