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
  analyzeAudioEnergy(src: string): Promise<EnergyProfile>; // BPM, beats
  extractTemplateStyle(src: string): Promise<StyleProfile>;  // cho STYLE_EDIT
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

### 2.6. applyGrade (StyleProfile.color)
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

### 2.11. extractTemplateStyle (STYLE_EDIT)
- `analyzeAudioEnergy` → BPM, beats (FFT qua `astats`/`ebur128` hoặc lib).
- Phân tích histogram frame → `color`.
- Frame diff → `motion`, `transitions`.
- VLM (VisionProvider) đọc overlay → `text`.
→ trả `StyleProfile` (xem `05`).

---

## 3. Worker & tài nguyên

- Render chạy trong **BullMQ worker riêng** (không block API).
- Giới hạn concurrent render (sem)) theo CPU/RAM; phim 2–3h cần transcode song song chunk.
- File trung gian lưu `storage/tmp`, dọn sau khi xuất.

---

## 4. Quyết định media

| Quyết định | Lý do |
| --- | --- |
| Mezzanine trước concat | concat nhanh, tránh re-encode lặp |
| speed qua setpts/atempo | align chính xác, giữ đồng bộ |
| xfade cho transition | mượt, không nhảy hình |
| style qua LUT/eq | sát video mẫu, nhẹ |
