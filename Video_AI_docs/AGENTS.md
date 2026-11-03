# AGENTS — Hướng dẫn cho AI Coding Agents

## 1. Nhiệm vụ cốt lõi (Mission)
- Phát triển tính năng theo từng bước nhỏ (incremental delivery).
- Không bao giờ sinh mã giữ chỗ (placeholder/TODO code).
- Luôn chạy kiểm thử hồi quy đầy đủ trước khi hoàn thành công việc.

## 2. Quy trình làm việc (Workflow)
1. Đọc [`docs/00_TAM_NHIN_VA_YEU_CAU.md`](docs/00_TAM_NHIN_VA_YEU_CAU.md) để nắm tầm nhìn, phạm vi và yêu cầu của 3 chế độ (`SUMMARY`, `TRANSLATE_DUB`, `SCRIPT_TO_VIDEO`).
2. Đọc [`docs/01_KIEN_TRUC_TONG_THE.md`](docs/01_KIEN_TRUC_TONG_THE.md) để hiểu kiến trúc tổng thể, layout thực tế `backend/` + `frontend/`, và các luồng pipeline.
3. Đọc tài liệu chi tiết tương ứng:
   - Pipeline logic & thuật toán: [`docs/05_THIET_KE_PIPELINE_CHI_TIET.md`](docs/05_THIET_KE_PIPELINE_CHI_TIET.md).
   - Thiết kế cơ sở dữ liệu (SQLite `sql.js` 29 bảng): [`docs/02_THIET_KE_CO_SO_DU_LIEU.md`](docs/02_THIET_KE_CO_SO_DU_LIEU.md).
   - Thiết kế Backend & services: [`docs/03_THIET_KE_BACKEND.md`](docs/03_THIET_KE_BACKEND.md).
   - Thiết kế Frontend & giao diện: [`docs/04_THIET_KE_FRONTEND.md`](docs/04_THIET_KE_FRONTEND.md).
   - REST API & Resumable upload: [`docs/06_API.md`](docs/06_API.md).
   - Xử lý Media / FFmpeg: [`docs/07_MODULE_FFMPEG.md`](docs/07_MODULE_FFMPEG.md).
   - Rate Limit & Free Tier: [`docs/11_RATE_LIMIT_VA_FREE_TIER.md`](docs/11_RATE_LIMIT_VA_FREE_TIER.md).
4. Hoàn thành từng tác vụ độc lập, tuân thủ Clean Architecture + Provider Pattern.

## 3. Cổng kiểm thử & Đảm bảo chất lượng (Verification Gates)
- **Backend**: `cd backend && npm test` (`node scripts/run-tests.mjs`). Chạy toàn bộ test suite hồi quy.
- **Frontend**: `cd frontend && npm run lint` và `npm run build`. (Frontend không có `npm test`).
- **Git Safety**: Không tự ý `git commit` hay `git push` nếu không có yêu cầu rõ ràng từ người dùng. Cấm tuyệt đối `git reset --hard` và `git clean -fd`.
