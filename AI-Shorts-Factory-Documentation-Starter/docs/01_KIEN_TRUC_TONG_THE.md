# 01 — Kiến trúc tổng thể

Tài liệu này là **trọng tâm** của bộ thiết kế: mô tả cấu trúc monorepo, luồng dữ liệu của hai pipeline,
mô hình Provider Pattern, hàng đợi và các sơ đồ trình tự.

---

## 1. Cấu trúc Monorepo (pnpm workspaces)

```
AI-Shorts-Factory/
├── apps/
│   ├── web/                  # Dashboard (React 19 + Vite)
│   └── api/                  # REST API (Express + TS)
├── packages/
│   ├── core/                 # Domain: entities, interfaces, orchestrator pipeline
│   ├── ai/                   # AIProvider (LLM) + Gemini/OpenAI/Anthropic/HuggingFace
│   ├── providers/
│   │   ├── asr/              # AsrProvider: Whisper / Faster-Whisper / OpenAI Whisper
│   │   ├── tts/              # TtsProvider: ElevenLabs / Google / Azure / OpenAI
│   │   ├── vision/           # VisionProvider: Gemini / CLIP (hiểu cảnh phim)
│   │   └── video-gen/        # (mở rộng) Kling/Hailuo/PixVerse...
│   ├── media/                # FFmpeg wrapper: transcode, scene-detect, concat, conform, grade
│   ├── queue/                # BullMQ + Redis: định nghĩa job, worker
│   ├── database/             # Prisma client + migrations
│   ├── shared/               # Zod schemas, types, constants, i18n
│   └── storage/              # Abstraction storage: local disk / S3
├── storage/                  # Volume lưu asset (images/audio/videos/subtitles/outputs)
├── docker/                   # Dockerfile, docker-compose, nginx
├── scripts/                  # migrate, seed, bench
└── docs/
```

**Quy tắc phụ thuộc (Dependency Rule):**
`apps/api` → `packages/core` → `packages/{ai,providers,media,queue,database,storage}` → `packages/shared`.
Lớp trên không được import implementation cụ thể của lớp dưới; chỉ qua **interface + DI**.

---

## 2. Tầng kiến trúc (Clean Architecture)

```
┌──────────────────────────────────────────────────────────┐
│ Presentation: apps/web (React)  +  apps/api (Controllers) │
├──────────────────────────────────────────────────────────┤
│ Application / Use-cases: services trong packages/core     │
│   - CreateProjectUseCase, SummaryPipeline, TranslateDubPipeline│
├──────────────────────────────────────────────────────────┤
│ Domain: entities, interfaces (AIProvider, AsrProvider...)  │
├──────────────────────────────────────────────────────────┤
│ Infrastructure: providers/*, media, database, storage, queue│
└──────────────────────────────────────────────────────────┘
```

- **Controllers** (api) chỉ parse request, gọi use-case, trả response.
- **Use-cases** (core) chứa business logic, điều phối provider qua interface.
- **Infrastructure** cài đặt interface; được bơm (inject) vào core qua DI container.

---

## 3. Hai luồng pipeline

### 3.1. Mode `SUMMARY` (Review phim)

```
Phim (2–3h)
   │
   ▼  [ingest]        probe + tách audio + lưu source
   ▼  [transcribe]    ASR → transcript(timestamp)
   ▼  [scene-detect]  media → Scene[] (start/end/thumbnail)
   ▼  [analyze]       VisionProvider → mô tả mỗi Scene
   ▼  [script]        LLM → ScriptSegment[] (lời review + scene ref)
   ▼  [align] ★       TTS đoạn → duration; gói Scene thành TimelineClip[]
   ▼  [tts]           TtsProvider → Audio(giọng review)
   ▼  [subtitle]     sinh cues khớp TTS
   ▼  [render]        media/ffmpeg → Video 20–30 phút
   ▼  [upload?]       YouTube
```

### 3.2. Mode `TRANSLATE_DUB` (Dịch thuật & Lồng tiếng)

```
Video nước ngoài (hardsub, ≤ 2GB)
   │
   ▼  [ingest]        resumable upload → demux (audio/video) → normalize LUFS
   ├──▶ [stt]         ASR → transcript(timestamp, speaker)      ┐ SONG SONG
   └──▶ [ocr]         frame sampling 1–2fps → OCR → OcrRegion[] ┘ (hardsub bbox)
   ▼  [translate]     LLM + StylePreset(12 phong cách) → bản dịch khớp context window
   ▼  [ttsAlign?]     TTS + Forced Alignment khớp slot gốc (tuỳ chọn enableDubbing)
   ▼  [composite]     mask hardsub (blur/fill/inpaint) → burn-in sub mới
                      → audio mix (dub voice + nền) → mux MP4/MKV (NVENC)
   ▼  [upload?]       YouTube
```

**Khác biệt cốt lõi:**
- `SUMMARY` cắt từ **1 video nguồn duy nhất** (phim) và phải đồng bộ giọng ↔ cảnh (stage `align`);
  đầu ra là **video mới dựng** từ các cảnh trích.
- `TRANSLATE_DUB` **giữ nguyên hình ảnh gốc**, chỉ thay lớp ngôn ngữ: phụ đề dịch đè lên vùng hardsub
  đã che và (tuỳ chọn) giọng lồng AI ép khớp timestamp; STT & OCR chạy song song để tối ưu latency.

---

## 4. Provider Pattern

Mọi dịch vụ ngoài được trừu tượng hoá qua interface. Ví dụ `TtsProvider`:

```ts
// packages/providers/tts/types.ts
export interface TtsProvider {
  readonly id: string;                 // 'elevenlabs' | 'google' | 'azure' | 'openai'
  synthesize(input: TtsInput): Promise<TtsResult>;
}

export interface TtsInput {
  text: string;
  language: string;                   // 'vi', 'en'...
  voiceId?: string;
  speed?: number;                     // 0.9–1.1
}

export interface TtsResult {
  audioKey: string;                   // storage key
  durationSec: number;                // ★ thời lượng CHÍNH XÁC (dùng cho align)
  provider: string;
  model: string;
  meta?: Record<string, unknown>;
}
```

Tương tự: `AIProvider` (LLM), `AsrProvider` (transcribe + word timestamps + diarization),
`OcrProvider` (phát hiện hardsub → bounding box), `VisionProvider` (mô tả cảnh / AI inpainting).

**Registry + Strategy:** dùng DI container ánh xạ `providerId → implementation`. Use-case chỉ gọi
`container.resolve('tts', settings.voiceProvider)`. Thêm provider = thêm 1 file implement + đăng ký,
**không sửa** business logic.

---

## 5. Hàng đợi (BullMQ + Redis)

Mỗi stage là 1 loại job. Worker tiêu thụ song song, retry tự động.

```
API ──enqueue──▶ Redis/BullMQ ──▶ Worker (per stage)
                        │
                        └─▶ GenerationJob (DB) gương trạng thái + log
```

| Job type | Stage | Retry |
| --- | --- | --- |
| `summary.transcribe` | ASR | 3, exp backoff |
| `summary.sceneDetect` | media | 2 |
| `summary.analyze` | vision | 3 |
| `summary.script` | llm | 3 |
| `summary.align` | core | 2 |
| `summary.tts` | tts | 3 |
| `summary.subtitle` | media | 2 |
| `summary.render` | media | 2 |
| `dub.ingest` | media (demux + LUFS) | 2 |
| `dub.stt` | asr (+ diarization) | 3 |
| `dub.ocr` | ocr (frame sampling) | 3 |
| `dub.translate` | llm + StylePreset | 3 |
| `dub.ttsAlign` | tts + ForcedAlignService | 3 |
| `dub.render` | media (mask/burn-in/mix/mux) | 2 |
| `output.uploadYoutube` | api | 2 |

Mỗi job **idempotent**: key theo `(projectId, stage)`. Thất bại → tự động retry; hết retry → đánh dấu
`GenerationJob.status = FAILED` và thông báo user.

---

## 6. Sơ đồ trình tự (Sequence) — SUMMARY

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web
  participant A as API
  participant Q as Queue
  participant C as Core(Align)
  participant P as Providers
  participant M as Media(ffmpeg)
  participant D as DB

  U->>W: Upload phim + cấu hình
  W->>A: POST /projects + start SUMMARY
  A->>D: Tạo Project(mode=SUMMARY)
  A->>Q: enqueue transcribe/sceneDetect/analyze
  Q->>P: ASR + Vision
  P-->>D: transcript, Scene[], mô tả
  A->>Q: enqueue script
  Q->>P: LLM sinh ScriptSegment[]
  P-->>D: kịch bản review
  A->>Q: enqueue align
  Q->>C: Align(tập ScriptSegment, Scene)
  C->>P: TTS mỗi đoạn → duration
  C->>C: gói Scene thành TimelineClip[] (khớp thời lượng)
  C-->>D: TimelineClip[]
  A->>Q: enqueue render
  Q->>M: ffmpeg ghép theo TimelineClip
  M-->>D: Output(video 20–30ph)
  A-->>W: notify hoàn thành
```

### 6.1. Sơ đồ trình tự — TRANSLATE_DUB

```mermaid
sequenceDiagram
  actor U as User
  participant W as Web
  participant A as API
  participant Q as Queue
  participant P as Providers (ASR/OCR/LLM/TTS)
  participant C as Core(ForcedAlign)
  participant M as Media(ffmpeg)
  participant D as DB

  U->>W: Upload video resumable + chọn preset/dubbing
  W->>A: POST /projects + start TRANSLATE_DUB
  A->>D: Tạo Project(mode=TRANSLATE_DUB)
  A->>Q: enqueue dub.stt ‖ dub.ocr (song song)
  Q->>P: ASR(audio LUFS) ; OCR(frames 1–2fps)
  P-->>D: TranscriptSegment[] ; OcrRegion[]
  A->>Q: enqueue dub.translate
  Q->>P: LLM dịch theo StylePreset (context window)
  P-->>D: translation gắn vào transcript
  alt enableDubbing
    A->>Q: enqueue dub.ttsAlign
    Q->>C: TTS từng câu → ép khớp slot gốc
    C-->>D: Audio dub + startAtSec
  end
  A->>Q: enqueue dub.render
  Q->>M: mask OcrRegion → burn-in sub → mix → mux (NVENC)
  M-->>D: Output(video đã Việt hoá)
  A--)W: SSE progress realtime từng stage
```

---

## 7. Storage Abstraction

`packages/storage` định nghĩa `StorageProvider` (`put`, `get`, `delete`, `signedUrl`).
MVP cài đặt `LocalStorage` (ghi vào `storage/`), production cài đặt `S3Storage`.
Mọi asset (phim nguồn, scene, audio, video, subtitle, output) lưu qua abstraction → dễ đổi hạ tầng.

---

## 8. Quyết định thiết kế (Design Decisions)

| Quyết định | Lý do |
| --- | --- |
| Tách `script` và `scene selection` nhưng gộp ở `align` | Đảm bảo giọng ↔ cảnh đồng bộ từ **cùng một biên thời gian** |
| TTS trả `durationSec` chính xác | Làm Input cho `align`, tránh đoán thời lượng |
| STT & OCR tách 2 job chạy song song | Độc lập dữ liệu → giảm latency tổng của TRANSLATE_DUB |
| OCR trả region timeline (không phải bbox rời) | Mask & burn-in cần vùng ổn định theo `[startSec, endSec]` |
| StylePreset lưu DB (không hardcode) | Thêm/sửa phong cách dịch không phải deploy lại code |
| Job idempotent + DB mirror | Quan sát & tiếp tục từ stage lỗi |
| Monorepo pnpm | Chia sẻ type/Zod giữa web & api, build nhất quán |
