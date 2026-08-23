# Roadmap (Lộ trình triển khai)

Dựa trên thiết kế tại [`01_KIEN_TRUC_TONG_THE.md`](01_KIEN_TRUC_TONG_THE.md) và
[`05_THIET_KE_PIPELINE_CHI_TIET.md`](05_THIET_KE_PIPELINE_CHI_TIET.md).

## Giai đoạn 1 — Nền tảng
- [ ] Monorepo pnpm, tsconfig strict, lint/prettier/husky.
- [ ] Prisma schema (`02_THIET_KE_CO_SO_DU_LIEU.md`) + migrate SQLite.
- [ ] Auth JWT access/refresh, RBAC, mã hoá API key.
- [ ] Storage abstraction (local), Provider Pattern skeleton + DI.

## Giai đoạn 2 — Pipeline SUMMARY (review phim)
- [ ] ingest + transcribe (ASR).
- [ ] scene-detect + Vision mô tả cảnh.
- [ ] LLM sinh kịch bản review (ScriptSegment).
- [ ] **AlignService** (đồng bộ giọng ↔ cảnh).
- [ ] TTS + subtitle + render (ffmpeg).

## Giai đoạn 3 — Pipeline STYLE_EDIT
- [ ] style-analyze → StyleProfile.
- [ ] storyboard từ assets + StyleProfile.
- [ ] render theo phong cách mẫu.

## Giai đoạn 4 — Vận hành
- [ ] BullMQ worker scale, retry.
- [ ] Dashboard (wizard, timeline preview, queue, logs).
- [ ] YouTube upload, Analytics, Admin.
- [ ] Docker / CI / production (Postgres, S3).
