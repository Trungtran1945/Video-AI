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
- **AlignService**: test invariant `sum(clip.duration*speed) ≈ D` với nhiều kịch bản (thiếu cảnh, thừa cảnh).
- **StyleAnalyzer**: fixture video mẫu → assert `StyleProfile` có trường bắt buộc.
- **API**: test controller qua supertest + mock use-case.
- **E2E pipeline**: dùng video ngắn (30s) thay phim 2–3h để chạy nhanh.

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
