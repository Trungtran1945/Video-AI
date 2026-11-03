# Claude / AI Assistant Instructions

Tuân thủ hướng dẫn tại `AGENTS.md` và root `AGENTS.md`.

**Ghi chú triển khai:**
- Tuân thủ nguyên tắc SOLID, Clean Architecture, Provider Pattern và bàn giao từng phần (incremental delivery).
- Kiến trúc hiện tại sử dụng JavaScript (ES modules), không dùng TypeScript.
- Cơ sở dữ liệu sử dụng `sql.js` (SQLite in-memory với tệp lưu trữ đĩa `backend/data.db` và single-writer lock), không dùng Prisma.
- Hỗ trợ 3 chế độ sản xuất: `SUMMARY`, `TRANSLATE_DUB`, và `SCRIPT_TO_VIDEO`.
- Luôn kiểm thử: `backend: npm test`, `frontend: npm run lint && npm run build`.
