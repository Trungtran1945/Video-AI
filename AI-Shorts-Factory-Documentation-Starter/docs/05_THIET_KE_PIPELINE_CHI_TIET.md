# 05 — Thiết kế Pipeline chi tiết

Tài liệu này đi sâu vào **thuật toán cốt lõi** của hai mode. Đây là phần quan trọng nhất để đảm bảo:
- `SUMMARY`: **giọng đọc review khớp với cảnh phim được cắt**.
- `TRANSLATE_DUB`: phụ đề dịch & giọng lồng tiếng **khớp chính xác timestamp gốc** của video nước ngoài.

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

# B. MODE TRANSLATE_DUB — Dịch thuật & Lồng tiếng

Biến một video nước ngoài (có phụ đề cứng/hardsub) thành bản tiếng Việt: dịch phụ đề theo phong cách
tuỳ chọn (13 StylePreset) và **(tuỳ chọn)** lồng tiếng AI, giữ nguyên hình ảnh gốc.

## B.0. Tổng quan stage

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| ingest | media | demux audio/video, chuẩn hoá LUFS, metadata |
| stt ‖ ocr ★ | AsrProvider ‖ OcrProvider (**chạy SONG SONG**) | `TranscriptSegment[]` / `OcrRegion[]` |
| translate | AIProvider(LLM) | bản dịch theo StylePreset, gắn vào transcript |
| ttsAlign ★ | TtsProvider + ForcedAlignService (core) | audio dub khớp slot thời gian (tuỳ chọn) |
| composite | media (+ VisionProvider nếu inpaint) | mask hardsub → burn-in sub mới → mix → mux |

Nhánh `stt` và `ocr` **độc lập dữ liệu** nên được enqueue song song để tối ưu latency.
Stage `translate` chỉ chạy khi cả hai xong: dịch dựa trên transcript, còn mask dựa trên OCR regions.

## B.1. Stage: ingest & tiền xử lý

- **Upload resumable**: client chia file (≤ 2GB) thành chunk 5–10MB upload song song (giao thức
  kiểu TUS). Mất mạng ở 99% → resume từ offset đã nhận, không tải lại từ đầu (xem `06_API.md`).
- **Demux FFmpeg**: tách audio stream (WAV/FLAC 16kHz mono cho ASR) và video stream.
- **Audio normalization LUFS** (`loudnorm`, mục tiêu −16): âm lượng đều → STT chính xác hơn.
- Probe metadata (duration, resolution, fps) phục vụ frame sampling & toạ độ bounding box.

## B.2. Stage: stt (ASR)

- Gọi `AsrProvider.transcribe(audio)` trên audio đã normalize → segments `{start, end, text}`
  kèm **word-level timestamps**.
- **Speaker diarization**: gán nhãn người nói (`SPK_1`, `SPK_2`...) khi video có nhiều nhân vật →
  lưu vào `TranscriptSegment.speaker`.
- Phát hiện ngôn ngữ nguồn tự động (hoặc theo `params.sourceLanguage`).

## B.3. Stage: ocr (phát hiện hardsub)

- **Frame sampling**: trích 1–2 khung hình/giây (`media.sampleFrames`) — đủ dày để bắt text,
  đủ thưa để tiết kiệm GPU.
- `OcrProvider.detect(frame)` → bounding box `{x, y, width, height, text, confidence}`.
- **Merge boxes liên tiếp**: box cùng vị trí (IoU > 0.7) qua các frame liền kề được gộp thành
  `OcrRegion { startSec, endSec, x, y, width, height, text }`.
- Lọc nhiễu: bỏ region hiện < 0.5s hoặc confidence thấp; vùng dưới 1/3 khung hình được ưu tiên
  (vị trí phụ đề phổ biến).
- User có thể chỉnh/tạo thêm region trên Canvas (`source='MANUAL'`) trước render.

## B.4. Stage: translate (LLM + 13 StylePreset)

- **Context window**: gom nhóm TranscriptSegment (~10 câu / ~30 giây) gửi LLM một lần để bản dịch
  mạch lạc, không mất ngữ cảnh giữa chừng; giữ glossary tên riêng nhất quán toàn video.
- **Routing 13 phong cách**: `StylePreset.systemPrompt` được inject vào System Prompt → AI điều chỉnh
  văn phong, đại từ nhân xưng và slang:

| slug | Phong cách | Đặc trưng văn phong |
| --- | --- | --- |
| co-trang | Cổ trang | cổ phong, xưng hô "bổn tọa", "hiền muội" |
| bat-trend | Bắt trend | Gen Z, slang mạng, lối nói viral |
| review-phim | Review phim | phân tích, châm biếm nhẹ |
| tinh-cam | Tình cảm / học đường | mềm mại, xưng "anh/em" |
| tai-lieu | Tài liệu / chính biên | chuẩn mực, trung tính |
| hai-huoc | Hài hước / meme | chơi chữ, twist bất ngờ |
| chinh-luan | Tin tức / chính luận | trang trọng, khách quan |
| gaming | Gaming / esports | thuật ngữ game, năng lượng cao |
| kinh-di | Kinh dị / rùng rợn | giọng kể căng, rùng rợn |
| the-thao | Thể thao | sôi động, cảm thán |
| cong-nghe | Công nghệ | chính xác thuật ngữ kỹ thuật |
| tre-em | Thiếu nhi / gia đình | đơn giản, dễ hiểu |
| sat-nghia | Sát nghĩa (Nguyên gốc) | dịch sát nguyên gốc, giữ nguyên cấu trúc câu, không thêm bớt ý |

- **Ràng buộc output**: trả JSON `{ "segments": [{ "index", "translation" }] }`; độ dài bản dịch
  ≈ bản gốc (±20%) để không vỡ forced alignment ở stage sau.
- Ghi `ProviderLog` (provider, model, tokens, cost) như mọi cuộc gọi AI khác.

## B.5. ★ Stage: ttsAlign (TTS + Forced Alignment) — KHÓ NHẤT

Chỉ chạy khi `params.enableDubbing = true`. Mục tiêu: giọng dub nằm trọn trong slot
`[startSec, endSec]` của câu gốc — không hình đi trước tiếng, không tiếng chồng sang câu sau.

### Thuật toán

```
cho mỗi TranscriptSegment seg (đã có translation):
  1. audio = TtsProvider.synthesize(seg.translation, targetLanguage, voiceId)
     D_tts  = audio.durationSec          // thời lượng đọc thực tế
     D_slot = seg.endSec - seg.startSec  // slot của câu gốc
  2. if D_slot*0.92 <= D_tts <= D_slot*1.08:
        đặt tại startSec, giữ nguyên            // trong dung sai ±8%
  3. elif D_tts > D_slot*1.08:                  // đọc dài hơn slot
        a. tempo = clamp(D_tts/D_slot, 1.0, 1.15) → atempo tăng tốc nhẹ
        b. vẫn thừa? → yêu cầu LLM rút gọn bản dịch (pass 2: "rút còn X%") rồi TTS lại
        c. vẫn trượt? → overlap tối đa 0.3s vào khoảng lặng kế tiếp
  4. elif D_tts < D_slot*0.92:                  // ngắn hơn slot
        chèn silence padding (30% đầu / 70% cuối) hoặc atempo chậm nhẹ (không dưới 0.9)
  5. ghi startAtSec thực tế + audioId vào TranscriptSegment.ttsAudioId
```

### Đảm bảo khớp (Invariant)

- Lệch biên mỗi segment < 5% slot; **không segment nào chồng lên segment kế**.
- `atempo` bị chặn trong [0.9–1.15] để giọng không méo; ưu tiên **rút gọn câu thay vì hớt tốc độ**.
- Word-level khớp (karaoke-style) dùng tham khảo **Dynamic Time Warping (DTW)** khi cần.

## B.6. Stage: composite — mask hardsub

Áp dụng theo từng `OcrRegion` (chỉ trong `[startSec, endSec]`, không đè toàn bộ video),
method theo `params.maskMethod`:

| Method | Cơ chế | Ưu/nhược |
| --- | --- | --- |
| `blur` | Gaussian/box blur vùng bbox | nhanh, rẻ — nhưng chữ lem vẫn lộ vệt |
| `fill` | sample màu nền quanh bbox → lấp phẳng (`drawbox`) | xử lý lem/nhòe tốt hơn blur |
| `inpaint` | AI inpainting tái tạo nền (VisionProvider), ffmpeg chỉ composite | đẹp nhất, tốn GPU nhất |

## B.7. Stage: composite — burn-in, mix, mux

- **Burn-in phụ đề mới**: file ASS có `\pos` khớp bbox cũ (hoặc vị trí user chọn) →
  `media.burnSubtitlesStyled`.
- **Audio mixing**:
  - Dubbing bật: thay voice gốc bằng dub track; giữ background (nhạc/tiếng động môi trường) nếu
    hệ thống tách stem được; ducking −12dB; `loudnorm` lần cuối.
  - Dubbing tắt: giữ nguyên audio gốc, chỉ thay phụ đề.
- **Muxing**: đóng gói video + audio mới thành MP4/MKV, ưu tiên tăng tốc phần cứng NVENC.

---

# C. So sánh hai mode

| Tiêu chí | SUMMARY | TRANSLATE_DUB |
| --- | --- | --- |
| Nguồn | 1 phim (cắt cảnh dựng review) | 1 video nước ngoài (giữ nguyên hình ảnh gốc) |
| Nhánh AI | ASR + Vision + LLM viết kịch bản | ASR ‖ OCR song song + LLM dịch |
| Đồng bộ | Align giọng ↔ cảnh (pack scene theo D) | Forced align dub ↔ slot timestamp gốc |
| Văn phong | tone tự do từ user | 1 trong 13 StylePreset cố định |
| Che/b đè chữ | Không | Mask hardsub (blur/fill/inpaint) + burn-in sub mới |
| TimelineClip | Có (ghép cảnh) | Không (render theo cue + OcrRegion) |
| Độ dài đầu ra | 20–30 phút | Bằng đúng duration video gốc |

---

# D. Quyết định pipeline

| Quyết định | Lý do |
| --- | --- |
| TTS nằm trong align (SUMMARY) | lấy `duration` làm chuẩn đồng bộ |
| Scene được trim/speed thay vì ghép thừa | giữ giọng tự nhiên, không vỡ nhịp |
| STT & OCR chạy 2 job song song | độc lập dữ liệu → giảm latency tổng |
| OCR merge box theo IoU theo thời gian | bbox từng frame nhiễu; region timeline ổn định cho mask & burn-in |
| Bản dịch gom theo context window | dịch trọn mạch câu, tránh lệch ngữ cảnh giữa các segment |
| TTS + forced align tách khỏi translate | retry TTS không phải dịch lại; invariant đo được (< 5%) |
| Rút gọn câu trước khi tăng tốc quá mức | atempo giới hạn [0.9–1.15], giọng dub tự nhiên |
| `fill` màu nền là mặc định thay `blur` | blur để lại vệt chữ lem; inpaint đẹp nhưng đắt GPU |
