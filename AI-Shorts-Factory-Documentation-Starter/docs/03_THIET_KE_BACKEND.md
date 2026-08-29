# 03 — Thiết kế Backend

Backend (`apps/api`) là Express + TypeScript (strict), tổ chức theo **Clean Architecture** và
**Dependency Injection**. Mọi logic nghiệp vụ nằm ở `packages/core`; API chỉ là lớp biên (boundary).

---

## 1. Cấu trúc thư mục `apps/api`

```
apps/api/
├── src/
│   ├── index.ts              # bootstrap: load env, DI, swagger, listen
│   ├── container.ts          # DI registry (provider, db, storage, queue)
│   ├── middlewares/
│   │   ├── auth.ts           # JWT verify + role
│   │   ├── validate.ts       # Zod guard
│   │   └── error.ts           # centralized error
│   ├── controllers/
│   │   ├── auth.controller.ts
│   │   ├── project.controller.ts
│   │   ├── output.controller.ts
│   │   ├── queue.controller.ts
│   │   └── admin.controller.ts
│   ├── routes/               # gắn controller + middleware
│   └── lib/                  # pino logger, swagger setup
├── Dockerfile
└── package.json
```

---

## 2. Dependency Injection

Dùng container nhẹ (vd `tsyringe` hoặc tự viết `Map`). Ví dụ:

```ts
// apps/api/container.ts
import { TtsProvider } from '@asf/providers/tts';
import { ElevenLabsTts } from '@asf/providers/tts/elevenlabs';
import { GoogleTts } from '@asf/providers/tts/google';

export const container = new Container();
container.register('tts', 'elevenlabs', () => new ElevenLabsTts());
container.register('tts', 'google', () => new GoogleTts());

// core use-case chỉ biết interface
export function resolveTts(id: string): TtsProvider {
  return container.resolve('tts', id);
}
```

Use-case gọi `resolveTts(settings.voiceProvider)` → **không biết** implementation cụ thể.

---

## 3. Use-cases (Application layer — `packages/core`)

- `CreateProjectUseCase` — validate, lưu Project, enqueue stage đầu.
- `SummaryPipeline` — điều phối các stage SUMMARY (gọi provider qua interface).
- `TranslateDubPipeline` — điều phối các stage TRANSLATE_DUB; đặc biệt **enqueue `dub.stt` và
  `dub.ocr` song song**, chỉ sang `dub.translate` khi cả hai xong (BullMQ `Promise.all` trên 2 job,
  hoặc job tổng hợp `dub.merge` chờ kết quả).
- `AlignService` — thuật toán đồng bộ giọng ↔ cảnh của SUMMARY (xem `05`).
- `ForcedAlignService` — ép khớp thời lượng TTS vào slot timestamp gốc của TRANSLATE_DUB
  (tempo stretching / chèn lặng / yêu cầu rút gọn câu).
- `SubtitleMaskService` — quản lý OcrRegion: merge bbox OCR, nhận region MANUAL từ Canvas,
  chọn method blur/fill/inpaint.
- `RenderService` — gọi `packages/media` sinh video.

Ví dụ controller mỏng:

```ts
// project.controller.ts
export async function startSummary(req: Req, res: Res) {
  const uc = container.resolve(CreateProjectUseCase);
  const project = await uc.execute({ ...req.body, mode: 'SUMMARY', userId: req.user.id });
  await enqueueSummary(project.id);
  res.status(202).json(project);
}

export async function startTranslateDub(req: Req, res: Res) {
  const uc = container.resolve(CreateProjectUseCase);
  const project = await uc.execute({ ...req.body, mode: 'TRANSLATE_DUB', userId: req.user.id });
  await Promise.all([enqueueDubStt(project.id), enqueueDubOcr(project.id)]); // song song
  res.status(202).json(project);
}
```

---

## 4. Xác thực & phân quyền (Auth)

- **Access token** (JWT, 15 phút) + **Refresh token** (JWT, 7 ngày, rotate).
- Refresh lưu hash trong `User.refreshToken`; mỗi lần refresh phát token mới & thu hồi cũ.
- Middleware `auth(['ADMIN'])` cho route quản trị.
- **Mã hoá API key**: `ApiKey.encryptedKey` = AES-256-GCM với khóa từ env `MASTER_KEY`.
  Khi dùng, giải mã trong memory, không log.

### Roles

| Role | Quyền |
| --- | --- |
| GUEST | xem landing, docs |
| USER | CRUD project của mình, quản lý API key, xem log project mình |
| ADMIN | xem tất cả project, analytics toàn hệ, quản lý provider global, user |

---

## 5. Validation (Zod)

Mọi request qua `validate(schema)`. Schema chia sẻ từ `packages/shared` (web & api dùng chung).

```ts
// packages/shared/schemas/project.ts
export const CreateSummarySchema = z.object({
  title: z.string().min(3),
  language: z.enum(['vi', 'en', 'ja', 'ko', 'zh']),
  style: z.string(),
  targetDurationSec: z.number().int().min(1200).max(1800),
  params: z.object({ tone: z.string(), spoilerAllowed: z.boolean() }).optional(),
});

export const CreateTranslateDubSchema = z.object({
  title: z.string().min(3),
  sourceLanguage: z.enum(['auto', 'en', 'ja', 'ko', 'zh']).default('auto'),
  targetLanguage: z.enum(['vi', 'en']).default('vi'),
  stylePreset: z.string(),            // slug của 1 trong 13 StylePreset
  enableDubbing: z.boolean().default(false),
  voiceId: z.string().optional(),     // bắt buộc khi enableDubbing
  maskMethod: z.enum(['blur', 'fill', 'inpaint']).default('fill'),
  sourceVideoKey: z.string(),         // đã upload resumable xong
});
```

---

## 6. Logging & quan sát (ProviderLog)

Dùng **Pino** cho app log. Mọi cuộc gọi provider bọc bởi `tracked(provider, type, fn)`:

```ts
export async function tracked<T>(meta: ProviderMeta, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const r = await fn();
    await logProvider({ ...meta, status: 'ok', durationMs: Date.now() - start });
    return r;
  } catch (e) {
    await logProvider({ ...meta, status: 'error', error: String(e), durationMs: Date.now() - start });
    throw e;
  }
}
```

`logProvider` ghi vào bảng `ProviderLog` (provider, model, tokensIn/Out, costUsd, durationMs, status).

---

## 7. Xử lý lỗi & idempotency

- Lỗi tập trung tại `error.ts` → format chuẩn `{ error: { code, message } }`.
- Mỗi job BullMQ có `jobId = `${projectId}:${stage}`` → không chạy trùng.
- Khi worker crash, BullMQ retry; `GenerationJob` lưu `attempts` & `error`.

---

## 8. Swagger / OpenAPI

- Định nghĩa schema qua decorator hoặc file YAML sinh tự động.
- Truy cập `/docs` (swagger-ui). Bao phủ tất cả route (xem `06_API.md`).

---

## 9. Quyết định backend

| Quyết định | Lý do |
| --- | --- |
| Tách core khỏi api | api chỉ biên; test core dễ (mock provider) |
| DI thay vì import tĩnh | thêm provider không sửa use-case |
| Zod ở shared | web & api đồng bộ schema, tránh lệch |
| AES API key | bảo mật secrets tại rest |
| Pino thay console | structured log, tốc độ cao |
