# 02 — Thiết kế cơ sở dữ liệu

Hệ thống dùng **Prisma ORM**. MVP: **SQLite**; production: **PostgreSQL** (chỉ đổi `provider` trong
`datasource`, schema không đổi). Tất cả thời gian lưu dạng `Float` (giây) hoặc `DateTime`.

---

## 1. Thực thể (Entities) & quan hệ

```
User 1──* Project 1──* Asset
                  │
                  ├──* GenerationJob
                  ├──* Scene             (SUMMARY)
                  ├──* ScriptSegment     (SUMMARY)
                  ├──* TimelineClip      (SUMMARY)
                  ├──* TranscriptSegment (TRANSLATE_DUB)
                  ├──* OcrRegion         (TRANSLATE_DUB)
                  ├──* Audio
                  ├──* Subtitle
                  └──* Output 1──* YouTubeUpload

User 1──* ApiKey
User 1──1 Settings
StylePreset (bảng dùng chung, seed 13 phong cách)
Project 1──* ProviderLog
GenerationJob 1──* ProviderLog
```

---

## 2. Schema Prisma (trích)

```prisma
// packages/database/prisma/schema.prisma
datasource db {
  provider = "sqlite"          // MVP; production: "postgresql"
  url      = env("DATABASE_URL")
}

generator client { provider = "prisma-client-js" }

enum Role       { USER ADMIN GUEST }
enum ProjectMode { SUMMARY TRANSLATE_DUB }
enum JobStatus  { PENDING RUNNING SUCCESS FAILED RETRY }
enum AssetKind  { VIDEO IMAGE AUDIO }
enum AudioKind  { VOICE MUSIC SFX }

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  role         Role     @default(USER)
  refreshToken String?
  createdAt    DateTime @default(now())
  apiKeys      ApiKey[]
  settings     Settings?
  projects     Project[]
}

model ApiKey {
  id         String   @id @default(uuid())
  userId     String
  provider   String   // 'gemini' | 'openai' | 'elevenlabs'...
  label      String
  encryptedKey String // mã hoá AES-256 tại rest
  createdAt  DateTime @default(now())
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Settings {
  userId          String   @id
  defaultLanguage String   @default("vi")
  defaultStyle    String   @default("bat-trend") // slug của StylePreset
  voiceProvider   String   @default("elevenlabs")
  maskMethod      String   @default("fill")      // 'blur' | 'fill' | 'inpaint'
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Project {
  id               String      @id @default(uuid())
  userId           String
  mode             ProjectMode
  title            String
  status           JobStatus   @default(PENDING)
  language         String      @default("vi")
  targetDurationSec Int        // SUMMARY: 1200–1800; TRANSLATE_DUB: bằng duration nguồn
  params           String?     // JSON SUMMARY: topic, tone... | TRANSLATE_DUB:
                               // { sourceLanguage, stylePreset, enableDubbing,
                               //   voiceId, maskMethod, subPosition }
  sourceVideoId    String?     // SUMMARY: phim gốc | TRANSLATE_DUB: video cần Việt hoá
  createdAt        DateTime    @default(now())
  user             User        @relation(fields: [userId], references: [id])
  assets           Asset[]
  jobs             GenerationJob[]
  scenes           Scene[]
  segments         ScriptSegment[]
  clips            TimelineClip[]
  transcriptSegments TranscriptSegment[]
  ocrRegions       OcrRegion[]
  audios           Audio[]
  subtitles        Subtitle[]
  outputs          Output[]
  logs             ProviderLog[]
}

model Asset {
  id         String    @id @default(uuid())
  projectId  String
  kind       AssetKind
  storageKey String
  meta       String?   // JSON: width,height,durationSec...
  durationSec Float?
  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model GenerationJob {
  id         String    @id @default(uuid())
  projectId  String
  type       String    // 'summary.transcribe' | 'dub.stt' | 'dub.ocr'...
  status     JobStatus @default(PENDING)
  step       String?
  payload    String?   // JSON
  result     String?   // JSON
  attempts   Int       @default(0)
  error      String?
  createdAt  DateTime  @default(now())
  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  logs       ProviderLog[]
}

model Scene {            // chỉ SUMMARY
  id          String   @id @default(uuid())
  projectId   String
  sourceVideoId String
  startSec    Float
  endSec      Float
  thumbnailKey String?
  description String?   // do VisionProvider sinh
  embedding   String?   // JSON vector (semantic match)
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model ScriptSegment {   // chỉ SUMMARY
  id               String   @id @default(uuid())
  projectId        String
  index            Int
  narration        String   // lời review
  targetDurationSec Float
  sceneRefs        String?  // JSON: [{sceneId, weight, reason}]
  voiceAudioId     String?
  subtitleId       String?
  project          Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model TimelineClip {    // chỉ SUMMARY
  id            String   @id @default(uuid())
  projectId     String
  order         Int
  sourceType    String   // 'SCENE'
  refId         String   // Scene.id
  inSec         Float    // điểm vào trên nguồn
  outSec        Float    // điểm ra
  speed         Float    @default(1.0) // 0.9–1.1 (align)
  transitionIn  String?  // 'fade' | 'cross' | null
  transitionOut String?
  voiceAudioId  String?
  startAtSec    Float    // vị trí trên timeline xuất
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model TranscriptSegment {  // TRANSLATE_DUB: 1 câu/đoạn thoại do STT nhận dạng
  id          String   @id @default(uuid())
  projectId   String
  index       Int
  startSec    Float    // mốc thời gian gốc — chuẩn cho mọi đồng bộ
  endSec      Float
  text        String   // văn bản gốc (STT)
  speaker     String?  // diarization: 'SPK_1'...
  language    String?  // ngôn ngữ nguồn (auto-detect)
  translation String?  // bản dịch đích (stage translate điền)
  ttsAudioId  String?  // audio dub đã ép khớp slot (nếu enableDubbing)
  subtitleId  String?
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model OcrRegion {          // TRANSLATE_DUB: vùng hardsub cần che/burn-in đè lên
  id          String   @id @default(uuid())
  projectId   String
  startSec    Float
  endSec      Float
  // Tọa độ LƯU THEO TỶ LỆ (0.0–1.0) so với kích thước khung hình gốc → scale-invariant,
  // không bị lệch khi render ở độ phân giải khác (4K nguồn → 1080p xuất, xem §1 lý do).
  ratioX      Float    // 0.0–1.0 (tỷ lệ theo chiều rộng)
  ratioY      Float    // 0.0–1.0 (tỷ lệ theo chiều cao)
  ratioW      Float    // 0.0–1.0
  ratioH      Float    // 0.0–1.0
  maskStrength Float  @default(0.6)  // 0.0–1.0: cường độ làm mờ (blur radius) + độ đục lớp phủ
  isStatic    Boolean  @default(false) // true: hardsub tĩnh → áp dụng cho toàn bộ duration (1 record)
  text        String?  // text gốc OCR đọc được (phục vụ đối chiếu bản dịch)
  confidence  Float?
  source      String   @default("AUTO") // 'AUTO' | 'MANUAL' (user khoanh trên Canvas)
  project     Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model StylePreset {        // 13 phong cách dịch, seed hệ thống
  id           String  @id @default(uuid())
  slug         String  @unique // 'co-trang', 'bat-trend', 'review-phim'...
  name         String
  description  String?
  systemPrompt String  // prompt inject vào LLM khi dịch
  isSystem     Boolean @default(true)
}

model Audio {
  id         String    @id @default(uuid())
  projectId  String
  kind       AudioKind
  storageKey String
  durationSec Float
  provider   String?
  project    Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model Subtitle {
  id         String   @id @default(uuid())
  projectId  String
  format     String   @default("srt") // 'srt' | 'vtt'
  language   String   @default("vi")
  storageKey String
  cues       String?  // JSON: [{start,end,text}]
  project    Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
}

model Output {
  id           String   @id @default(uuid())
  projectId    String
  storageKey   String
  status       JobStatus @default(SUCCESS)
  durationSec  Float?
  thumbnailKey String?
  createdAt    DateTime @default(now())
  project      Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  uploads      YouTubeUpload[]
}

model YouTubeUpload {
  id             String   @id @default(uuid())
  outputId       String
  status         JobStatus
  youtubeVideoId String?
  privacy        String   @default("private")
  error          String?
  output         Output   @relation(fields: [outputId], references: [id], onDelete: Cascade)
}

model ProviderLog {      // quan sát mọi cuộc gọi AI
  id         String   @id @default(uuid())
  projectId  String?
  jobId      String?
  provider   String
  type       String   // 'llm' | 'asr' | 'tts' | 'vision'
  model      String?
  tokensIn   Int?
  tokensOut  Int?
  costUsd    Float?
  durationMs Int?
  status     String   // 'ok' | 'error'
  error      String?
  createdAt  DateTime @default(now())
  project    Project? @relation(fields: [projectId], references: [id])
  job        GenerationJob? @relation(fields: [jobId], references: [id])
}
```

---

## 3. Chỉ mục & hiệu năng

- `GenerationJob(projectId, type)` — truy vấn tiến trình nhanh.
- `TimelineClip(projectId, order)` — xuất timeline tuần tự.
- `ProviderLog(createdAt)` — báo cáo cost/analytics.
- `Scene(embedding)` — MVP lưu JSON; PostgreSQL có thể chuyển `vector` extension để tìm cảnh ngữ nghĩa.

---

## 4. Migration & seed

```bash
pnpm --filter @asf/database prisma migrate dev --name init
pnpm --filter @asf/database prisma db seed   # user admin mặc định, settings
```

---

## 5. Quyết định DB

| Quyết định | Lý do |
| --- | --- |
| JSON cho `params/result/cues` | Linh hoạt, ít join, đủ với MVP |
| `OcrRegion` là bảng riêng, không nhét JSON | User sửa/xoá từng region (MANUAL) và render truy vấn theo `[startSec, endSec]` |
| `OcrRegion` lưu `ratioX/Y/W/H` (Float 0–1) thay vì pixel | Scale-invariant: vùng che không lệch khi nguồn 4K mà xuất 1080p; frontend lưu % và backend nhân `videoDims` khi render |
| `OcrRegion.maskStrength` (0–1) | Điều khiển đồng thời bán kính blur và độ đục lớp phủ — 1 tham số duy nhất cho thanh kéo "độ mờ" trên editor |
| `OcrRegion.isStatic` | Hardsub tĩnh (logo, credit) chỉ cần 1 record áp dụng cho toàn bộ video, tránh sinh hàng chục region rời rạc |
| `StylePreset` bảng riêng + seed | Thêm/sửa phong cách dịch không cần deploy code |
| `TimelineClip` chỉ SUMMARY | TRANSLATE_DUB render theo cue + OcrRegion, không dựng timeline |
| `TranscriptSegment` giữ cả text gốc & dịch | Đối chiếu song ngữ, retry TTS không mất bản dịch |
| `ProviderLog` độc lập | Analytics không phụ thuộc project còn tồn tại |
| SQLite → Postgres không đổi schema | Đổi `datasource` là đủ |

---

## 6. Ghi chú triển khai MVP (sql.js)

Backend MVP chạy bằng sql.js (SQLite) thay vì Prisma; schema SQL mirror 1-1 các model trên
(`backend/src/db/schema.js`). Các lệch có chủ đích, cần giữ nhất quán khi nâng cấp lên Postgres:

| Lệch | Chi tiết | Lý do |
| --- | --- | --- |
| Enum giá trị **lowercase** | DB/API lưu `'user'`, `'pending'`, `'completed'`, `'failed'`... thay vì `USER`, `PENDING`, `SUCCESS`... | SQLite không có enum native; frontend đang so sánh lowercase. Khi chuyển Postgres/Prisma phải map lại hoặc cập nhật toàn bộ consumer |
| Project hoàn thành dùng status `'completed'` | Ngoài enum `JobStatus` ở trên | Frontend lọc `'completed'`; khi migrate cân nhắc thêm giá trị này vào enum hoặc đổi sang `SUCCESS` |
| Project lưu song song `_id` + `_key` | `sourceVideoId` tham chiếu Asset (mục 2), đồng thời giữ `source_video_key` vì API (`06`) nhận/trả storage key | Tương thích API hiện tại và tham chiếu chuẩn theo mục 2 |
| Mode `TRANSLATE_DUB` lưu `'translate_dub'` | Giá trị mode lowercase có gạch dưới, thay cho `'style_edit'` cũ | Nhất quán với quy ước enum lowercase ở trên |
| Bảng mới mirror 1-1 | `transcript_segments`, `ocr_regions`, `style_presets` (seed 13 preset khi migrate) | Đảm bảo schema MVP khớp thiết kế Prisma |
| Bảng mở rộng `reset_tokens` | Flow quên mật khẩu (email + token + expires) | Không có trong schema gốc; xoá nếu bỏ flow forgot-password |
| Xoá project | `provider_logs.project_id` đặt `NULL` (không xoá log); `youtube_uploads` dọn qua join `outputs`; các bảng con còn lại xoá trực tiếp | Đúng quyết định "ProviderLog độc lập"; FK cascade chỉ áp dụng cho bảng tạo mới |
| Seed | Admin mặc định từ env `ADMIN_EMAIL`/`ADMIN_PASSWORD` (fallback dev) + row `settings` + 13 `style_presets` | Tương đương `prisma db seed` |
