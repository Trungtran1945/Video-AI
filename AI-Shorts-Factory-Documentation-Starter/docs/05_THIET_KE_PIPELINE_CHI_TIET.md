# 05 — Thiết kế Pipeline chi tiết

Tài liệu này đi sâu vào **thuật toán cốt lõi** của hai mode. Đây là phần quan trọng nhất để đảm bảo:
- `SUMMARY`: **giọng đọc review khớp với cảnh phim được cắt**.
- `STYLE_EDIT`: đầu ra **có phong cách y hệt video mẫu**.

---

# A. MODE SUMMARY — Review phim

## A.1. Tổng quan stage

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| ingest | media | source video đã probe, audio tách ra |
| transcribe | AsrProvider | transcript có timestamp (word/segment) |
| sceneDetect | media | `Scene[]` (start/end, thumbnail) |
| analyze | VisionProvider | mô tả + embedding mỗi Scene |
| script | AIProvider(LLM) | `ScriptSegment[]` (lời review + sceneRefs) |
| align ★ | AlignService (core) | `TimelineClip[]` khớp thời lượng |
| tts | TtsProvider | Audio giọng review (biết duration) |
| subtitle | media | Subtitle cues khớp TTS |
| render | media | Video 20–30 phút |

---

## A.2. Stage: transcribe (ASR)

- Tách audio 16kHz mono → chia chunk 10 phút (song song worker).
- Gọi `AsrProvider.transcribe(chunk)` → segments `{start,end,text}`.
- Ghép thành transcript toàn phim kèm timestamp tuyệt đối.
- **Phát hiện ngôn ngữ** tự động (hoặc theo `project.language`).

## A.3. Stage: sceneDetect (media/ffmpeg)

- Dùng filter `select=thumbnail=...` + `signalstats` hoặc thuật toán shot detection
  (PySceneDetect nếu cài). Ngưỡng cắt cảnh mặc định `threshold=0.4`.
- Mỗi Scene: `startSec, endSec, thumbnailKey`.
- Giới hạn: với phim 2–3h, có thể vài nghìn cảnh → gom nhóm thành **"key scenes"** (điểm cao trào)
  bằng thuật toán clustering theo độ biến thiên thị giác + transcript.

## A.4. Stage: analyze (VisionProvider)

- Với mỗi key scene, trích keyframe → `VisionProvider.describe(image)` → mô tả ngắn
  (vd: "cảnh chiến đấu giữa hai nhân vật chính dưới mưa").
- Sinh `embedding` (vector) từ mô tả → lưu `Scene.embedding` để **semantic match** với lời review.

## A.5. Stage: script (LLM) — sinh kịch bản review

Prompt gửi LLM:
- transcript (tóm lược) + danh sách key scene (id + mô tả + thời gian).
- yêu cầu: `language`, `style/tone`, `targetDurationSec` (1200–1800), `spoilerAllowed`.
- **bắt buộc trả JSON** theo schema:

```json
{
  "segments": [
    {
      "narration": "Mở đầu phim là cảnh...",
      "targetDurationSec": 45,
      "sceneRefs": [
        { "sceneId": "s_12", "weight": 0.8, "reason": "giới thiệu bối cảnh" },
        { "sceneId": "s_15", "weight": 0.5 }
      ]
    }
  ]
}
```

- LLM **chỉ chọn scene đã có sẵn** (không bịa), ưu tiên phân bố đều theo thời lượng phim.
- `targetDurationSec` mỗi segment được LLM ước sao tổng ≈ `targetDurationSec` project.

## A.6. ★ Stage: align (ĐỒNG BỘ GIỌNG ↔ CẢNH) — QUAN TRỌNG NHẤT

Mục tiêu: mỗi đoạn lời review `narration` có thời lượng TTS = `D`, và các cảnh được chọn phải
**lấp đầy đúng D** để giọng và hình khớp nhau.

### Thuật toán

```
với mỗi ScriptSegment seg:
  1. audio = TtsProvider.synthesize(seg.narration, language, voice)
     D = audio.durationSec                      // thời lượng CHÍNH XÁC
  2. candidates = seg.sceneRefs sắp xếp theo weight giảm dần
  3. pack(candidates, D):
       total = 0; chosen = []
       cho mỗi scene sc trong candidates:
         dur = sc.endSec - sc.startSec
         if total + dur <= D * 1.08:           // dung sai +8%
            chosen.push(sc); total += dur
         else:
            // cắt mép scene để vừa: lấy phần đầu dur' = D*1.08 - total
            chosen.push(trim(sc, dur')); total += dur'; break
       // nếu vẫn thiếu (total < D*0.92): mở rộng bằng cách
       //  - tăng speed các clip (0.9–1.1x) cho đến khớp, hoặc
       //  - thêm scene tương đồng (semantic match embedding gần nhất chưa dùng)
       // nếu vẫn thừa: giảm speed / cắt bớt mép cuối
  4. gán cho mỗi chosen: startAtSec chạy tuần tự, transition mặc định 'cross'
  5. lưu TimelineClip[] (sourceType='SCENE', refId=sceneId, in/out, speed)
```

### Đảm bảo khớp (Invariant)

- `sum(TimelineClip.duration * speed) ≈ D` (sai lệch < 1s).
- Vì TTS là nguồn thời gian, và clip được gói theo D → **giọng và cảnh luôn đồng bộ**.
- Nếu `D` vượt quá tổng cảnh có sẵn (hiếm), Align báo `GenerationJob` cần thêm scene hoặc user
  giảm độ dài → không vỡ sync.

### Xử lý transition

- Giữa hai clip: `transitionOut` của clip trước = `transitionIn` của clip sau = 'cross' (0.3s).
- Thời lượng transition đã tính vào `startAtSec` (overlap) để không làm lệch giọng.

---

## A.7. Stage: tts & subtitle

- `tts` đã chạy bên trong `align` để lấy `D`. Ở stage này chỉ lưu `Audio` & gán `voiceAudioId`.
- `subtitle`: từ `ScriptSegment.narration` + thời điểm `startAtSec` của clip chứa nó → sinh cues SRT/VTT.
  Đảm bảo phụ đề bám theo giọng (cùng biên với TimelineClip).

## A.8. Stage: render (media/ffmpeg)

Xem chi tiết `07_MODULE_FFMPEG.md`. Tóm tắt:
- Transcode mỗi Scene được chọn → mezzanine (H.264 1080p, tốc độ nhanh cho concat).
- Áp dụng `speed` (setpts + atempo tương ứng cho audio nếu cần).
- Concat theo `order`, chèn transition.
- Overlay voice track (duck dưới nhạc nền tuỳ chọn), `loudnorm`.
- Burn-in hoặc mux subtitle.
- Thêm intro/outro (template), lower-third tiêu đề phim.
- Xuất 16:9, 20–30 phút.

---

# B. MODE STYLE_EDIT — Edit theo mẫu

## B.1. Stage: style-analyze → StyleProfile

Phân tích video mẫu (`templateVideoId`) để trích **StyleProfile** (JSON):

```json
{
  "aspectRatio": "9:16",
  "transitions": { "default": "slide", "durationSec": 0.4, "pattern": "ABAB" },
  "pacing": { "avgShotLen": 2.2, "beatSync": true, "bpm": 120 },
  "color": { "lut": "teal-orange", "contrast": 1.1, "saturation": 1.15, "temperature": "cool" },
  "motion": { "kenBurns": true, "zoomRange": [1.0, 1.12], "pan": "slow" },
  "text": { "font": "Montserrat", "position": "bottom", "animation": "fade-up", "size": 48 },
  "audio": { "musicBed": true, "ducking": -12 }
}
```

Cách trích:
- **pacing/bpm**: `media` phân tích năng lượng âm thanh (FFT) → BPM; đo khoảng cách cut.
- **color**: trung bình histogram → áp dụng LUT xấp xỉ (preserve hue) hoặc `eq/colorbalance`.
- **motion**: detect optical flow / zoom qua frame diff → tham số ken-burns.
- **text**: VLM đọc overlay tiêu đề → font/position/animation (gần đúng).
- **transitions**: so sánh frame liền kề → phân loại cut/fade/slide.

## B.2. Stage: storyboard (LLM/core)

- Input: assets (ảnh/video/audio) + StyleProfile + `targetDurationSec` (30–60), `style`.
- LLM sắp xếp assets thành `Shot[]`:
  ```json
  [{ "assetId": "a_3", "durationSec": 2.2, "transition": "slide",
     "motion": "kenBurns", "grade": "teal-orange", "text": "Cảnh 1" }]
  ```
- Tổng duration ≈ target. Nếu cần lời dẫn → sinh `narration` rồi TTS.

## B.3. Stage: render

- Mỗi asset → resize/crop theo `aspectRatio` (9:16), áp dụng `motion` (zoom/pan), `grade` (color),
  `transition`, cắt theo BPM (`beatSync`).
- Overlay `text` theo style, ghép music bed (cắt nhịp), duck voice.
- Xuất 30s–1phút.

**Khác SUMMARY:** STYLE_EDIT không cần `align` (không có nguồn đồng bộ); nó **áp dụng StyleProfile**
lên assets rời. Đầu ra mang phong cách mẫu nhờ các tham số đã học.

---

# C. So sánh hai mode

| Tiêu chí | SUMMARY | STYLE_EDIT |
| --- | --- | --- |
| Nguồn hình ảnh | 1 phim (cắt cảnh) | Nhiều assets rời |
| Đồng bộ giọng↔cảnh | Bắt buộc (align) | Không (lời dẫn tuỳ chọn) |
| Tham số phong cách | Từ user (tone) | Từ video mẫu (StyleProfile) |
| Độ dài | 20–30 phút | 30s–1phút |
| Tỷ lệ | 16:9 (review) | 9:16 (shorts) |

---

# D. Quyết định pipeline

| Quyết định | Lý do |
| --- | --- |
| TTS nằm trong align | lấy `duration` làm chuẩn đồng bộ |
| Scene được trim/speed thay vì ghép thừa | giữ giọng tự nhiên, không vỡ nhịp |
| StyleProfile tách riêng assets | tái dùng mẫu, so sánh dễ |
| Vision mô tả scene → embedding | semantic match khi thiếu cảnh |
