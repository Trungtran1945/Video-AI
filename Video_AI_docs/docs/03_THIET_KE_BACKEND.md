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
  - **Overlap Detection**: Khi người dùng điều chỉnh `startSec`/`endSec` của segment N, hệ thống kiểm tra
    và xử lý theo **một quy tắc thống nhất** (không để 2 hướng xử lý mơ hồ như trước):
    1. Validate trước: `endSec` của segment N-1 phải ≤ `startSec` của segment N (cho phép khoảng lặng
       hợp lý ≥ 0.1s). Nếu vi phạm với segment N-1 → **từ chối** request, trả lỗi `VAL_002`
       (segment trước là "quá khứ", không được tự ý đẩy lùi vì có thể phá đồng bộ đã xác nhận).
    2. Với segment N+1 trở về sau (chưa được user xác nhận thủ công, `isTimeManuallyAdjusted=false`):
       hệ thống **tự động đẩy** `startSec`/`endSec` của các segment liền sau theo đúng độ lệch, miễn
       không vượt slot của segment kế tiếp đó — trả về danh sách segment bị ảnh hưởng trong response
       để UI hiển thị rõ (`{ adjustedSegments: [...] }`).
    3. Nếu segment kế tiếp **đã** được user tự chỉnh tay (`isTimeManuallyAdjusted=true`) và việc đẩy
       sẽ đè lên nó → từ chối request với `VAL_002`, yêu cầu user tự giải quyết xung đột thủ công.
    
  - **CPS Validation (Characters Per Second)**: Trước khi render, tính `CPS = length(translation) / (endSec - startSec)`. Nếu `CPS > 25` và `isTimeManuallyAdjusted == true`, trả về warning trong `GenerationJob.result`:
    ```json
    { "warnings": [{ "segmentId": "...", "type": "reading_speed", "cps": 32.5, "threshold": 25 }] }
    ```
- `SubtitleMaskService` — quản lý OcrRegion: merge bbox OCR, nhận region MANUAL từ Canvas
  (lưu `ratioX/Y/W/H` scale-invariant), chọn method `blur`/`fill`/`inpaint`, áp dụng `maskStrength`
  (độ mờ: blur radius + độ đục lớp phủ), gộp hardsub tĩnh (`isStatic` → 1 record cho toàn video),
  và tính vị trí phụ đề mới ưu tiên trùng/nằm ngay trên vùng đã mask (point 2, xem `01` §3.2).
- `RenderService` — gọi `packages/media` sinh video.
- `CancelProjectUseCase` — huỷ job `PENDING`/`RUNNING` của 1 project (BullMQ `job.remove()` +
  cờ `cancelled` cho worker đang chạy), đặt `Project.status = FAILED`, `cancelledAt = now()`,
  dọn file tạm liên quan (xem `01` §5.2).
- **Giới hạn concurrency (NFR-12)**: `CreateProjectUseCase` kiểm tra
  `count(Project where userId=X and status='RUNNING') < MAX_CONCURRENT_PROJECTS` (mặc định 2,
  cấu hình qua env `MAX_CONCURRENT_PROJECTS_PER_USER`) trước khi enqueue stage đầu; vượt ngưỡng →
  Project tạo với `status=QUEUED`, một cron/worker nhẹ định kỳ quét và enqueue project `QUEUED`
  cũ nhất khi có slot trống.
- `QuotaGuardService` — kiểm tra mức dùng provider trước khi enqueue các stage tốn nhiều request
  (`analyze`, `tts`, `ttsAlign`, `translate`, `ocr`); cảnh báo sớm khi gần chạm giới hạn free tier.
  Chi tiết thuật toán, `RateLimiter` (Token Bucket + Sliding Window), `ProviderCache` và đa key
  round-robin nằm ở `11_RATE_LIMIT_VA_FREE_TIER.md` — **bắt buộc đọc trước khi cài đặt bất kỳ
  provider client nào**, vì mọi lời gọi provider thật phải đi qua các lớp bọc này thay vì gọi SDK
  trực tiếp.

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
  // ⚠️ inpaint là premium (gọi thêm Vision/Inpainting Provider, chậm & tốn cost);
  // blur/fill là mặc định nhanh nhẹ (docs/00 FR-T8).
  maskStrength: z.number().min(0).max(1).default(0.6), // độ mờ: blur radius + độ đục lớp phủ
  subPosition: z.enum(['original', 'top', 'bottom', 'custom']).default('original'),
  // 'original' = đè lên vùng mask; 'top'/'bottom' = safe zone; 'custom' = toạ độ riêng
  sourceVideoKey: z.string(),         // đã upload resumable xong
});

export const UpdateSegmentTimingSchema = z.object({
  segmentId: z.string().uuid(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
}).refine(data => data.endSec > data.startSec, {
  message: "endSec must be greater than startSec"
});

export const CreateProjectBaseSchema = z.object({
  // ... các field theo mode (xem CreateSummarySchema / CreateTranslateDubSchema) +
  copyrightAcknowledged: z.literal(true, {
    errorMap: () => ({ message: "Bạn phải xác nhận quyền sử dụng nội dung nguồn trước khi tạo project" }),
  }),
});
```

---

## 6. Logging & quan sát (ProviderLog)

Dùng **Pino** cho app log. Mọi cuộc gọi provider bọc bởi `tracked(provider, type, fn)` —
**và trước đó** bởi `RateLimiter.acquire()`/`ProviderCache` (xem `11_RATE_LIMIT_VA_FREE_TIER.md` §2.3
cho lớp `callProvider()` bọc ngoài `tracked()`):

```ts
export async function tracked<T>(meta: ProviderMeta, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const r = await fn();
    await logProvider({ ...meta, status: 'ok', durationMs: Date.now() - start });
    return r;
  } catch (e) {
    const status = isRateLimitError(e) ? 'rate_limited' : 'error'; // phân biệt hết quota tạm thời
    await logProvider({ ...meta, status, error: String(e), durationMs: Date.now() - start });
    throw e;
  }
}
```

`logProvider` ghi vào bảng `ProviderLog` (provider, model, tokensIn/Out, costUsd, durationMs, status).
Giá trị `status='rate_limited'` giúp `QuotaGuardService` và trang `Logs`/`Analytics` phân biệt rõ
"đang chờ tài nguyên bên ngoài hồi phục" với "lỗi cần sửa code/cấu hình".

---

## 7. Xử lý lỗi & idempotency

- Lỗi tập trung tại `error.ts` → format chuẩn `{ error: { code, message } }`.
- Mỗi job BullMQ có `jobId = `${projectId}:${stage}`` → không chạy trùng.
- Khi worker crash, BullMQ retry; `GenerationJob` lưu `attempts` & `error`.
- **Riêng lỗi rate-limit/quota** (xem `11` §4.2): job không dùng backoff cố định như lỗi thường —
  `nextRetryAt` được tính theo `Retry-After` của provider hoặc chu kỳ reset RPM/RPD đã biết trước,
  và số lần retry cho phép cao hơn (mặc định 5) vì bản chất là chờ tài nguyên hồi phục, không phải
  lỗi logic cần sửa code.

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
| Overlap: từ chối đè lên segment N-1 / segment đã tự chỉnh, tự đẩy segment N+1 chưa chỉnh | Một quy tắc duy nhất, tránh nhập nhằng giữa "tự động sửa" và "báo lỗi" như thiết kế trước |
| Giới hạn `MAX_CONCURRENT_PROJECTS_PER_USER` | Tránh 1 user chiếm hết worker GPU/CPU khi chưa có hệ thống gói cước (NFR-12) |
| `copyrightAcknowledged` bắt buộc ở schema tạo project | Ép xác nhận bản quyền ngay tại validation layer, không thể bỏ qua qua client (NFR-14) |
| Mọi provider client đi qua `callProvider()` (RateLimiter + Cache) | Free-tier API key có RPM/RPD thấp; không throttle chủ động sẽ vỡ pipeline khi test nhiều lần (`11`) |
