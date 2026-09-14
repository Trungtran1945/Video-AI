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

Biến một video nước ngoài thành bản tiếng Việt: dịch phụ đề theo phong cách
tuỳ chọn (13 StylePreset) và **(tuỳ chọn)** lồng tiếng AI, giữ nguyên hình ảnh gốc.

## B.0. Tổng quan stage

| Stage | Thực thi bởi | Đầu ra chính |
| --- | --- | --- |
| ingest | media | demux audio/video, chuẩn hoá LUFS, metadata |
| stt | AsrProvider | `TranscriptSegment[]` |
| merge | core | Kiểm tra barrier: transcript + translation + duration + language |
| translate | AIProvider(LLM) | bản dịch theo StylePreset, gắn vào transcript |
| ttsAlign ★ | TtsProvider + ForcedAlignService (core) | audio dub khớp slot thời gian (tuỳ chọn) |
| render | media | burn-in sub mới → mix → mux |

Stage `translate` chỉ chạy khi `merge` hoàn thành: kiểm tra transcript, translation, duration và language config.

## B.1. Stage: ingest & tiền xử lý

- **Upload resumable**: client chia file (≤ 2GB) thành chunk 5–10MB upload song song (giao thức
  kiểu TUS). Mất mạng ở 99% → resume từ offset đã nhận, không tải lại từ đầu (xem `06_API.md`).
- **Hạn chế URL**:
  - **Chỉ chấp nhận `minio://` (nội bộ)** — KHÔNG chấp nhận HTTP/HTTPS URL từ internet vì:
    • Hầu hết video platform (YouTube, Bilibili...) chặn direct link → download timeout/fail
    • Không có fallback mechanism → phải upload file vật lý
    • User đọc docs sẽ thất vọng khi link không hoạt động
  - **Hạn chế dung lượng file upload**: Tối đa **500MB** (configurable qua `MEDIA_MAX_UPLOAD_SIZE_MB`).
    File vượt quá sẽ bị reject ngay từ API, KHÔNG enqueue vào queue để tránh lãng phí tài nguyên worker.
- **Demux FFmpeg**: tách audio stream (WAV/FLAC 16kHz mono cho ASR) và video stream.
- **Audio normalization LUFS** (`loudnorm`, mục tiêu −16 LUFS):
  - Chạy 2-pass: Pass 1 phân tích, Pass 2 áp dụng normalization → âm lượng đều, STT chính xác hơn.
  - Nếu audio đã normalize trước đó (double normalization) → bỏ qua, giữ nguyên.
  - Nếu audio quá ồn (SNR < threshold) → cảnh báo nhưng không block pipeline.
- Probe metadata (duration, resolution, fps) phục vụ frame sampling & toạ độ bounding box.

## B.2. Stage: stt (ASR)

- Gọi `AsrProvider.transcribe(audio)` trên audio đã normalize → segments `{start, end, text}`
  kèm **word-level timestamps**.
- **Auto-detect ngôn ngữ nguồn**: mặc định hệ thống tự phát hiện ngôn ngữ từ audio (không yêu cầu
  `sourceLanguage` bắt buộc khi tạo project). Kết quả detect hiển thị cho user ở màn preview.
- **Override thủ công**: user có thể override ngôn ngữ nguồn nếu detect sai (vd audio có nhiều ngôn ngữ
  trộn, hoặc detect nhầm phương ngữ). Nếu user override → **chỉ chạy lại Stage STT** với `sourceLanguage`
  chỉ định (không detect lại), không ảnh hưởng các Stage khác đã hoàn tất trước đó — các Stage phía sau
  (`TRANSLATE`/`TTS`) sẽ bị đánh dấu `STALE` nếu đã chạy.
- **Speaker diarization**: gán nhãn người nói (`SPK_1`, `SPK_2`...) khi video có nhiều nhân vật →
  lưu vào `TranscriptSegment.speaker`.
- **Audio câm/không có giọng nói**: trả transcript rỗng, Stage STT vẫn `COMPLETED` (không phải lỗi),
  nhưng cảnh báo ở UI "Không phát hiện lời thoại".
- **Audio quá dài**: có thể cần chia nhỏ theo chunk trước khi gửi provider (nhiều provider giới hạn
  độ dài file); xử lý chunk + ghép lại timestamp là trách nhiệm của AsrProvider.
- **Nhiều giọng nói chồng lấn (overlapping speech)**: MVP không tách speaker diarization đầy đủ,
  transcript chỉ lấy giọng nói chính; ghi nhận là giới hạn đã biết, không phải lỗi.

## B.3. Stage: translate (LLM + 13 StylePreset)

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

## B.4. ★ Stage: ttsAlign (TTS + Forced Alignment) — KHÓ NHẤT

Chỉ chạy khi `params.enableDubbing = true`. Mục tiêu: giọng dub nằm trọn trong slot
`[startSec, endSec]` của câu gốc — không hình đi trước tiếng, không tiếng chồng sang câu sau.

### Yêu cầu bắt buộc

1. **TTS chỉ được phép khi có TTS voice đã cấu hình**: Kiểm tra `(workspace.tts_provider_id IS NOT NULL OR workspace.tts_cloud_provider IS NOT NULL)` TRƯỚC khi bắt đầu Stage. Nếu chưa cấu hình → chuyển MediaJob sang `FAILED` với thông báo lỗi rõ ràng, không chạy lang thang.
2. **Forbidden providers**: Không được phép sử dụng các provider đã bị cấm trong hệ thống.
3. **Mapping Model → Provider**: Yêu cầu TTS MUST map sang provider đã cấu hình (theo bảng trong `03_THIET_KE_BACKEND.md`).
4. **Fallback về Piper local**: Khi tất cả cloud provider đều bị cấm hoặc lỗi → fallback về Piper local (`SYSTEM_TTS`).
5. **`tts_audio_ref` là Source of Truth**: Luôn sử dụng `tts_audio_ref` để xác định audio đã dub (KHÔNG dùng `dub_track_asset_id`). Nếu cả hai tồn tại → onError hiển thị: "Hệ thống cần refresh/re-process để đồng bộ dữ liệu. Vui lòng chọn 'Rerun dubbing'."

### Thuật toán chi tiết

```
cho mỗi TranscriptSegment seg (đã có translation):
  1. audio = TtsProvider.synthesize(seg.translation, targetLanguage, voiceId)
     D_tts  = audio.durationSec          // thời lượng đọc thực tế
     D_slot = seg.endSec - seg.startSec  // slot của câu gốc

  2. Xử lý lệch timing:

     ┌─ TRƯỜNG HỢP 1: Khớp (±20%) ─────────────────────────────────────────┐
     │   Condition: D_slot*0.80 <= D_tts <= D_slot*1.20                      │
     │   Action: Đặt tại startSec, giữ nguyên duration thực tế              │
     │   Music alignment: Không thay đổi                                     │
     └───────────────────────────────────────────────────────────────────────┘

     ┌─ TRƯỜNG HỢP 2: Dài hơn slot (>20%) ──────────────────────────────────┐
     │   Condition: D_tts > D_slot * 1.20                                    │
     │   Severity: BLOCKING                                                  │
     │   Action: Stage TTS → FAILED                                           │
     │   User notification: "Dịch quá dài so với slot. Cần rút gọn {X}%."   │
     │   Music alignment: Ngăn render tránh video/audio lệch                  │
     └───────────────────────────────────────────────────────────────────────┘

     ┌─ TRƯỜNG HỢP 3: Ngắn hơn slot (>20%) ─────────────────────────────────┐
     │   Condition: D_tts < D_slot * 0.80                                    │
     │   Severity: NON_BLOCKING                                              │
     │   Action: Chèn silence padding (30% đầu / 70% cuối)                   │
     │   Music alignment: Giữ nguyên, pad không lệch                          │
     │   Note: <5% câu thường lệch >20%, render vẫn tiếp tục                 │
     └───────────────────────────────────────────────────────────────────────┘

     ┌─ TRƯỜNG HỢP 4: Lệch nhỏ (5-20%) ────────────────────────────────────┐
     │   Condition: D_tts lệch 5-20% so với D_slot                           │
     │   Severity: NON_BLOCKING                                              │
     │   Action: Nhẹ → time-stretch tối đa ±20% (atempo 0.8–1.2)            │
     │            Vẫn lệch → overlap tối đa 0.3s vào khoảng lặng kế tiếp    │
     │   Music alignment: Time-stretch nudges music theo DUB_TTS_DURATION     │
     └───────────────────────────────────────────────────────────────────────┘
```

### Partial success handling (TTS) — ✅ ĐÃ TRIỂN KHAI

- **Hiện tại**: Mỗi segment xử lý độc lập, segment lỗi không chặn các segment khác.
  - Stage `TTS` → `COMPLETED` nếu có ít nhất 1 segment thành công.
  - Stage `TTS` → `FAILED` nếu toàn bộ segment đều lỗi.
  - Segment lỗi giữ `tts_audio_id = NULL`, render fallback giọng gốc.
- **Trả về**: `{ dubbedCount, errorCount, errors: [{segmentId, indexNum, error}], stageStatus }`
- **User có thể retry thủ công segment lỗi** (UI hiển thị danh sách segment lỗi).

### Đảm bảo khớp (Invariant)

- Lệch biên mỗi segment < 5% slot; **không segment nào chồng lên segment kế**.
- `atempo` bị chặn trong [0.8–1.2] để giọng không méo; ưu tiên **rút gọn câu thay vì hớt tốc độ**.
- Word-level khớp (karaoke-style) dùng tham khảo **Dynamic Time Warping (DTW)** khi cần.

## B.5. Stage: render — Burn-in sub mới — ✅ ĐÃ CẢI THIỆN

- **BLOCK_RENDER validation** (transflow doc 15 §5.0): Kiểm tra TRƯỚC khi kích hoạt render:
  - Có transcript segments không
  - Tất cả segments đã có translation
  - Duration hợp lệ (>0 và <=300s)
  - Nếu enableDubbing: tất cả segments có translation phải có TTS audio
  - Nếu validation fail → FAILED ngay, không gọi FFmpeg
- **Burn-in phụ đề mới**: file ASS có vị trí mặc định đáy khung hình →
  `media.burnSubtitlesStyled`.
- **Audio mixing** (xem `07_MODULE_FFMPEG.md` chi tiết):
  - **Dubbing bật**: thay voice gốc bằng dub track.
    - **Timing lệch lớn (>20%)**: Stage đề xuất rút gọn câu dịch.
    - **Timing lệch nhỏ (5-20%)**: time-stretch audio dub ±20% cho khớp slot (atempo 0.8–1.2).
    - **Timing khớp (±20%)**: giữ nguyên audio dub thực tế.
    - **Partial success**: Segment thiếu TTS audio dùng giọng gốc (fallback).
    - Giữ background (nhạc/tiếng động môi trường) nếu hệ thống tách stem được; ducking −12dB;
      `loudnorm` lần cuối.
    - **Lưu ý quan trọng**: `tts_audio_ref` là source of truth cho audio đã dub, KHÔNG dùng
      `dub_track_asset_id` (deprecated).
  - **Dubbing tắt**: giữ nguyên audio gốc, chỉ thay phụ đề.
- **Muxing**: đóng gói video + audio mới thành MP4/MKV, ưu tiên tăng tốc phần cứng NVENC.
- **Render validation**:
  - Kiểm tra output không bị corrupt (FFmpeg probe).
  - Kiểm tra duration output ±2s so với duration gốc.
  - Nếu render fail → retry theo policy (2 lần, backoff 30s→120s), sau đó `FAILED`.
- **Retry policy** (transflow doc 15 §7):
  - `dub.render`: max 2 retries, backoff 30s → 120s
  - `dub.ttsAlign`: max 3 retries, backoff 10s → 30s → 60s
  - `dub.stt`: max 3 retries, backoff 10s → 30s → 60s
  - `dub.translate`: max 3 retries, backoff 5s → 15s → 30s
- **Subtitle presentation options** (user chọn trước render):
  - `target_font`: Font-family từ danh sách có sẵn (Arial, Noto Sans CJK, v.v.).
  - `target_font_size`: Font size (16–48px), mặc định 22px.
  - `target_opacity`: Đopacity (0.5–1.0), mặc định 1.0.
  - `target_color`: Font color hex (mặc định `#FFFFFF`).
  - `subtitle_position`: Vị trí phụ đề (`TOP`, `MIDDLE`, `BOTTOM`), mặc định `BOTTOM`.
  - `hard_sub_enabled`: Boolean — burn subtitle vào video (mặc định `true` cho TRANSLATE_ONLY).

---

# C. So sánh hai mode

| Tiêu chí | SUMMARY | TRANSLATE_DUB |
| --- | --- | --- |
| Nguồn | 1 phim (cắt cảnh dựng review) | 1 video nước ngoài (giữ nguyên hình ảnh gốc) |
| Nhánh AI | ASR + Vision + LLM viết kịch bản | ASR + LLM dịch |
| Đồng bộ | Align giọng ↔ cảnh (pack scene theo D) | Forced align dub ↔ slot timestamp gốc |
| Văn phong | tone tự do từ user | 1 trong 13 StylePreset cố định |
| Che/b đè chữ | Không | Burn-in sub mới |
| TimelineClip | Có (ghép cảnh) | Không (render theo cue) |
| Độ dài đầu ra | 20–30 phút | Bằng đúng duration video gốc |

---

# D. Quyết định pipeline

| Quyết định | Lý do |
| --- | --- |
| TTS nằm trong align (SUMMARY) | lấy `duration` làm chuẩn đồng bộ |
| Scene được trim/speed thay vì ghép thừa | giữ giọng tự nhiên, không vỡ nhịp |
| Burn-in sub mới thay vì mask hardsub | Đơn giản hóa pipeline, giảm thời gian render, không cần OCR |
| Bản dịch gom theo context window | dịch trọn mạch câu, tránh lệch ngữ cảnh giữa các segment |
| TTS + forced align tách khỏi translate | retry TTS không phải dịch lại; invariant đo được (< 5%) |
| Rút gọn câu trước khi tăng tốc quá mức | atempo giới hạn [0.9–1.15], giọng dub tự nhiên |

---

# E. Retry Policy & Stage State Machine

## E.1. Stage State Machine (Áp dụng cho cả hai mode)

Mỗi Stage trong MediaJob đi qua các trạng thái:

```
PENDING → PROCESSING → COMPLETED
                 ↓
               FAILED (→ retry nếu còn lượt)
                 ↓
               STALE (khi dependency upstream thay đổi)
```

| Trạng thái | Ý nghĩa |
| --- | --- |
| `PENDING` | Chưa bắt đầu, chờ dependency hoặc queue |
| `PROCESSING` | Đang chạy (provider call, FFmpeg, v.v.) |
| `COMPLETED` | Thành công, output đã lưu DB |
| `FAILED` | Lỗi — có thể retry nếu chưa vượt max retry |
| `STALE` | Đã completed nhưng dependency upstream thay đổi → cần rerun |
| `SKIPPED` | Bỏ qua (vd: user tắt dubbing → Stage TTS được skip) |

**Quy tắc STALE**: Khi user thay đổi `sourceLanguage` sau khi STT đã COMPLETED → Stage STT được rerun;
các Stage `TRANSLATE`/`TTS` (nếu đã COMPLETED trước đó) → chuyển `STALE`, yêu cầu rerun.

## E.2. Retry Policy

| Stage Group | Max Retry | Delay | Retryable Errors |
| --- | --- | --- | --- |
| `EXTRACT_AUDIO` | 3 | 5s, 15s, 30s | Timeout, 5xx, network error |
| `STT` | 3 | 10s, 30s, 60s | Timeout, 429 (rate limit), 5xx |
| `TRANSLATE` | 3 | 5s, 15s, 30s | Timeout, 429, 5xx, invalid JSON |
| `SUMMARIZE` | 3 | 5s, 15s, 30s | Timeout, 429, 5xx, business rule violation |
| `TTS` | 3 | 10s, 30s, 60s | Timeout, voice not found, 5xx |
| `RENDER` | 2 | 30s, 120s | FFmpeg crash, disk full, timeout |

**Non-retryable errors** (FAILED ngay, không retry):
- `PROVIDER_AUTH_FAILED`: API key sai/hết hạn → user cần cập nhật key
- `PROVIDER_QUOTA_EXCEEDED`: Hết quota provider → user cần upgrade plan
- `INPUT_INVALID`: File video corrupt, codec không hỗ trợ
- `BUSINESS_RULE_VIOLATION`: Dịch quá dài/ngắn so với slot (không phải lỗi provider)

**Exponential backoff**: Delay tăng theo `baseDelay * 2^attempt`, max `baseDelay * 8`.

## E.3. Idempotent Callback

- Worker gửi callback về backend PHẢI chứa `(jobId, stage, status, outputRef)` + timestamp.
- Backend kiểm tra: nếu `(jobId, stage)` đã ở trạng thái `COMPLETED` với `outputRef` trùng khớp →
  ACK lại ngay, không xử lý lại (idempotent).
- Nếu `outputRef` khác → coi như rerun mới, xử lý bình thường.

## E.4. Cancellation (Graceful)

- User gửi `CANCEL_REQUESTED` → MediaJob chuyển `CANCEL_REQUESTED`.
- Nếu Stage hiện tại đang `PROCESSING` → đợi provider hoàn tất (hoặc timeout 60s) rồi chuyển `CANCELLED`.
- Nếu Stage `PENDING` → chuyển `CANCELLED` ngay lập tức.
- **Không thể cancel Stage đang FFmpeg render** (đã beyond MVP; tương lai: FFmpeg process group + SIGTERM).

## E.5. Partial Success (Summary Pipeline)

- **Stage SUMMARY (Summarize)** có thể sinh 3 proposal, mỗi proposal có số lượng beat khác nhau.
- Nếu proposal A có 5 beat, proposal B có 8 beat, proposal C có 3 beat → tất cả đều được hiển thị
  cho user chọn, bất kể số lượng (không có partial failure trong SUMMARY stage).
- **Stage TTS (ở SUMMARY mode)**: Nếu một số segment TTS thành công, một số lỗi →
  MediaJob `FAILED` toàn bộ (MVP). Tương lai: partial TTS audio + error reporting.
