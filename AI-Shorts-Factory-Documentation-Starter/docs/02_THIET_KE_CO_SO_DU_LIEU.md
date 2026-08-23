# 02 — Thiết kế cơ sở dữ liệu

Hệ thống dùng **Prisma ORM**. MVP: **SQLite**; production: **PostgreSQL** (chỉ đổi `provider` trong
`datasource`, schema không đổi). Tất cả thời gian lưu dạng `Float` (giây) hoặc `DateTime`.

---

## 1. Thực thể (Entities) & quan hệ

```
User 1──* Project 1──* Asset
                 │
                 ├──* GenerationJob
                 ├──* Scene           (SUMMARY)
                 ├──* ScriptSegment   (SUMMARY)
                 ├──* TimelineClip    (cả 2 mode)
                 ├──* Audio
                 ├──* Subtitle
                 └──* Output 1──* YouTubeUpload

User 1──* ApiKey
User 1──1 Settings
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
enum ProjectMode { SUMMARY STYLE_EDIT }
enum JobStatus  { PENDING RUNNING SUCCESS FAILED RETRY }
enum AssetKind  { VIDEO IMAGE AUDIO }
enum AudioKind  { VOICE MUSIC SFX }

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  role         Role     @default(USER)
  refreshToken String?
  credits      Int      @default(0)
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
  defaultStyle    String   @default("cinematic")
  voiceProvider   String   @default("elevenlabs")
  aspectRatio     String   @default("16:9") // SUMMARY; STYLE_EDIT dùng 9:16
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Project {
  id               String      @id @default(uuid())
  userId           String
  mode             ProjectMode
  title            String
  status           JobStatus   @default(PENDING)
  language         String      @default("vi")
  style            String      // 'cinematic' | 'review' | 'vlog'...
  targetDurationSec Int        // SUMMARY: 1200–1800; STYLE_EDIT: 30–60
  params           String?     // JSON: topic, tone, spoilerAllowed...
  sourceVideoId    String?     // SUMMARY: phim gốc
  templateVideoId  String?     // STYLE_EDIT: video mẫu
  createdAt        DateTime    @default(now())
  user             User        @relation(fields: [userId], references: [id])
  assets           Asset[]
  jobs             GenerationJob[]
  scenes           Scene[]
  segments         ScriptSegment[]
  clips            TimelineClip[]
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
  type       String    // 'summary.transcribe' | 'style.render'...
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

model TimelineClip {    // cả 2 mode
  id            String   @id @default(uuid())
  projectId     String
  order         Int
  sourceType    String   // 'SCENE' (SUMMARY) | 'ASSET' (STYLE_EDIT)
  refId         String   // Scene.id hoặc Asset.id
  inSec         Float    // điểm vào trên nguồn
  outSec        Float    // điểm ra
  speed         Float    @default(1.0) // 0.9–1.1 (align)
  transitionIn  String?  // 'fade' | 'cross' | null
  transitionOut String?
  voiceAudioId  String?
  startAtSec    Float    // vị trí trên timeline xuất
  project       Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
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
| `TimelineClip` chung cho 2 mode | Render dùng chung logic xuất |
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
| Project lưu song song `_id` + `_key` | `sourceVideoId`/`templateVideoId` tham chiếu Asset (mục 2), đồng thời giữ `source_video_key`/`template_video_key` vì API (`06`) nhận/trả storage key | Tương thích API hiện tại và tham chiếu chuẩn theo mục 2 |
| Bảng mở rộng `reset_tokens` | Flow quên mật khẩu (email + token + expires) | Không có trong schema gốc; xoá nếu bỏ flow forgot-password |
| Xoá project | `provider_logs.project_id` đặt `NULL` (không xoá log); `youtube_uploads` dọn qua join `outputs`; các bảng con còn lại xoá trực tiếp | Đúng quyết định "ProviderLog độc lập"; FK cascade chỉ áp dụng cho bảng tạo mới |
| Seed | Admin mặc định từ env `ADMIN_EMAIL`/`ADMIN_PASSWORD` (fallback dev) + row `settings` | Tương đương `prisma db seed` |
