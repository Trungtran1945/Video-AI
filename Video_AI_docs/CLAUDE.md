# Claude / AI Assistant Instructions

Tuân thủ hướng dẫn tại `AGENTS.md` và root `AGENTS.md`.

> [!NOTE]
> **Single Source of Truth:** Nguồn sự thật duy nhất là [`../AGENTS.md`](../AGENTS.md) ở root repository.

**Ghi chú triển khai:**
- Tuân thủ nguyên tắc SOLID, Clean Architecture, Provider Pattern và bàn giao từng phần (incremental delivery).
- Kiến trúc hiện tại sử dụng JavaScript (ES modules), không dùng TypeScript.
- Cơ sở dữ liệu sử dụng **PostgreSQL 16+** (`pg.Pool`) theo DDL `backend/src/db/postgresSchema.sql`, kết nối qua `DATABASE_URL`. Kiến trúc SQLite cũ đã được gỡ bỏ hoàn toàn.
- Hỗ trợ các chế độ sản xuất: `MEDIA_COMPOSER` (Flagship mới), `TRANSLATE_DUB`, `SCRIPT_TO_VIDEO`, và `SUMMARY` (Legacy).
- Luôn kiểm thử: `backend: npm test`, `frontend: npm run lint && npm run build`.
