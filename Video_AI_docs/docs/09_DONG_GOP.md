# 09 — Đóng góp và Quy trình phát triển

Tài liệu này định nghĩa quy trình đóng góp, chất lượng code và cấu trúc chuẩn để dự án nhất quán,
dễ bảo trì (theo yêu cầu Clean Architecture, SOLID, không code trùng lặp).

---

## 1. Quy tắc chung

- **Ngôn ngữ**: TypeScript strict ở mọi package.
- **Không hardcode secret**: luôn qua env / `MASTER_KEY`.
- **Không placeholder/TODO**: mọi code merge phải chạy được.
- **Không duplicate**: dùng lại service/component/hook có sẵn; nếu lặp >2 chỗ → đưa vào `shared` hoặc `core`.
- **Provider mới**: implement interface + đăng ký DI, **không sửa** use-case.

---

## 2. Code Quality

| Công cụ | Mục đích |
| --- | --- |
| ESLint | style, unused, hooks |
| Prettier | format nhất quán |
| TypeScript `--strict` | type safety |
| Husky + lint-staged | chạy lint/prettier trước commit |
| Commitlint | chuẩn hoá commit (`feat:`, `fix:`, `docs:`, `refactor:`) |
| Vitest / Jest | unit & integration test |

Cấu hình mẫu:
```jsonc
// package.json (root)
{
  "scripts": {
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "prepare": "husky install"
  }
}
```

---

## 3. Quy trình đóng góp (Contribution)

1. Fork / tạo branch `feature/<tên>` hoặc `fix/<tên>`.
2. Viết code + test (unit cho service, integration cho API/pipeline).
3. Chạy `pnpm lint && pnpm typecheck && pnpm test` — phải xanh.
4. Commit theo Commitlint; push & tạo PR.
5. PR cần ≥1 review (ADMIN duyệt nếu chạm core).
6. CI pass → merge vào `main` → auto deploy staging.

---

## 4. Cấu trúc thư mục chuẩn (áp dụng mọi package)

```
packages/<name>/
├── src/
│   ├── index.ts          # public API / barrel
│   ├── domain/           # interfaces, types
│   ├── application/      # use-cases (nếu có)
│   ├── infrastructure/   # implementations
│   └── __tests__/        # test
├── package.json
├── tsconfig.json
└── README.md (nếu phức tạp)
```

---

## 5. Viết test

- **Provider**: mock HTTP, assert gọi đúng & map kết quả; test lỗi → `ProviderLog` status error.
- **AlignService** (SUMMARY): test invariant `sum(clip.duration*speed) ≈ D` với nhiều kịch bản (thiếu cảnh, thừa cảnh).
- **ForcedAlignService** (TRANSLATE_DUB): fixture TTS dài/ngắn hơn slot → assert lệch < 5% slot,
  không segment nào chồng nhau, atempo không vượt [0.9–1.15].
- **OcrRegion merge**: boxes liên tiếp IoU > 0.7 → assert gộp đúng `[startSec, endSec]`; box hiện
  < 0.5s bị lọc.
- **TranslateService**: cùng input, khác StylePreset → assert đúng systemPrompt được inject và
  output khớp JSON schema `{segments:[{index, translation}]}`.
- **API**: test controller qua supertest + mock use-case.
- **E2E pipeline dùng video 30s**: mặc định chạy với `DEFAULT_PROVIDER_MODE=mock` trong CI (xem
  `11` §6) để tách biệt hoàn toàn khỏi rate limit của provider thật — CI **luôn xanh** bất kể free
  tier bên ngoài có bị giới hạn hay không.
- **CancelProjectUseCase**: assert job `PENDING` bị remove khỏi BullMQ, job `RUNNING` nhận tín hiệu
  `AbortSignal`, file tạm bị xoá, `Project.status = FAILED` với `cancelledAt` được set.
- **Overlap Detection (UpdateSegmentTimingSchema)**: fixture 3 segment liên tiếp — assert đè lên
  N-1 bị từ chối (`VAL_002`), đè lên N+1 chưa chỉnh tay thì tự đẩy đúng offset, đè lên N+1 đã
  `isTimeManuallyAdjusted=true` thì bị từ chối.
- **Concurrency limit**: tạo > `MAX_CONCURRENT_PROJECTS_PER_USER` project cùng lúc → assert project
  vượt ngưỡng có `status=QUEUED` thay vì enqueue ngay; assert cron dequeue đúng thứ tự FIFO khi có
  slot trống.
- **Cleanup cron**: fixture project có `expiresAt` trong quá khứ → assert file trong `storage/tmp`
  bị xoá, `Output` không bị ảnh hưởng.
- **RateLimiter (Token Bucket)**: fixture RPM=2 → gọi `acquire()` 5 lần liên tiếp, assert 2 lần đầu
  resolve ngay, các lần sau bị delay đúng theo cửa sổ; chạm `requestsPerDay` → assert throw
  `RateLimitExhaustedError` thay vì tiếp tục chờ vô hạn.
- **ProviderCache**: gọi `callProvider()` 2 lần với input giống hệt → assert lần 2 không tạo thêm
  `ProviderLog`, không gọi `fn()` thật, trả đúng kết quả cache.
- **Đa key round-robin**: fixture 2 `ApiKey` cùng provider, 1 key trả liên tiếp lỗi 429 → assert
  hệ thống tự chuyển sang key còn lại mà không làm job `FAILED`.
- **QuotaGuardService**: fixture `ProviderLog` gần chạm `requestsPerDay` → assert `getSnapshot()`
  trả `percentUsed ≥ 0.8` và job liên quan có `warnings` chứa `quota_risk`.

---

## 6. Tài liệu

- Mọi thay đổi API/schema phải cập nhật `06_API.md` / `02_CO_SO_DU_LIEU.md`.
- Thêm provider/mode → cập nhật `01_KIEN_TRUC_TONG_THE.md` & `05_PIPELINE`.
- Giữ README là chỉ mục.

---

## 7. Quyết định contribution

| Quyết định | Lý do |
| --- | --- |
| Husky + Commitlint | lịch sử sạch, dễ truy vết |
| Test mock provider | tốc độ + không tốn API thật |
| E2E dùng video 30s | pipeline chạy nhanh trong CI |
| Chuẩn thư mục mọi package | nhất quán, dễ onboard |
