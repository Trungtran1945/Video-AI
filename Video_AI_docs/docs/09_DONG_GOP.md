# 09 — Đóng góp và Quy trình Phát triển

Tài liệu này định nghĩa quy chuẩn đóng góp mã nguồn, tiêu chuẩn kiểm thử và quy trình đảm bảo chất lượng cho toàn bộ dự án Video-AI.

---

## 1. Quy tắc Phát triển Chung

- **Ngôn ngữ & Chuẩn mã nguồn**: JavaScript (ES modules) trên Node.js >=18; Frontend sử dụng React 18 + JSX + Tailwind CSS.
- **Không hardcode bí mật**: Tuyệt đối không lưu secret, token, mật khẩu hay API key trong mã nguồn; luôn đọc từ biến môi trường qua `src/config.js` hoặc giải mã qua `MASTER_KEY`.
- **Không sinh mã giữ chỗ (No Placeholder Code)**: Mọi đoạn mã được đẩy lên phải hoàn chỉnh, có khả năng thực thi và được kiểm chứng.
- **Provider Pattern**: Khi bổ sung một nhà cung cấp AI mới (TTS, LLM, ASR, Vision, Image), cài đặt trong `backend/src/providers/` và đăng ký qua `registry.js`, tuyệt đối không sửa đổi logic nghiệp vụ trong `runner.js`.

---

## 2. Tiêu chuẩn Chất lượng Mã nguồn (Verification Gates)

| Thành phần | Lệnh thực thi | Mục đích & Tiêu chuẩn |
| --- | --- | --- |
| **Backend Lint** | `cd backend && npm run lint` | Kiểm tra cú pháp ESLint toàn bộ thư mục `src/`, `tests/`, `scripts/` |
| **Backend Test** | `cd backend && npm test` | Chạy toàn bộ bộ kiểm thử hồi quy `node scripts/run-tests.mjs` (kiểm tra toàn bộ các file `tests/*.test.mjs`) |
| **Frontend Lint** | `cd frontend && npm run lint` | Kiểm tra cú pháp và quy chuẩn React/JSX |
| **Frontend Typecheck** | `cd frontend && npm run typecheck` | Kiểm tra kiểu dữ liệu nhẹ qua `tsc -p ./jsconfig.json` |
| **Frontend Build** | `cd frontend && npm run build` | Kiểm tra tính sẵn sàng của gói build Vite SPA |

> ⚠️ **Lưu ý Quan trọng**: Frontend không có lệnh `npm test` — không tự ý tạo thêm script test ở frontend. Cổng kiểm tra hồi quy chính của dự án là bộ test của backend (`cd backend && npm test`).

---

## 3. Quy trình Đóng góp (Contribution Workflow)

1. Tạo branch phát triển mới: `feature/<ten-tinh-nang>` hoặc `fix/<ten-loi>`.
2. Thực hiện thay đổi mang tính phẫu thuật (surgical changes): Chỉ chỉnh sửa những file thực sự cần thiết, không refactor lan man code không liên quan.
3. Thực hiện kiểm thử toàn diện:
   - Backend: `cd backend && npm run lint && npm test`.
   - Frontend: `cd frontend && npm run lint && npm run build`.
4. Tuân thủ quy định Git nghiêm ngặt:
   - Được phép chạy: `git status`, `git diff`, `git log`, `git branch`.
   - **Chỉ thực hiện `git commit`, `git push`, `git merge` khi người dùng yêu cầu rõ ràng** trong phiên làm việc hiện tại.
   - **Tuyệt đối không bao giờ chạy**: `git reset --hard` hoặc `git clean -fd`.

---

## 4. Viết Test & Kiểm thử Tự động

Mọi tính năng hoặc sửa lỗi mới đều cần đi kèm bài kiểm tra tương ứng trong `backend/tests/`:

- **Kiểm thử Provider AI**: Sử dụng mock HTTP hoặc `mockAsr`, `mockLlm`, `mockTts`, `mockVision` với biến môi trường `DEFAULT_PROVIDER_MODE=mock` để không tốn quota API thật.
- **Kiểm thử Pipeline SUMMARY**: Kiểm tra thuật toán `AlignService`, đảm bảo bất biến tổng thời lượng clip khớp với thời lượng giọng đọc review (`sai lệch < 1s`).
- **Kiểm thử Pipeline TRANSLATE_DUB**:
  - Kiểm tra `ForcedAlignService`: Tốc độ co dãn không vượt `TEMPO_MAX = 1.35`, tận dụng khoảng lặng pause-expansion, không chồng lấn timestamp giữa các câu thoại kế tiếp.
  - Kiểm tra tính bất biến của Mask: Mask ở trạng thái `APPROVED` không được phép sửa toạ độ (`409 MASK_APPROVED_IMMUTABLE`).
  - Kiểm tra validation trước render (`BLOCK_RENDER`): Dừng ngay lập tức nếu thiếu bản dịch hoặc thiếu audio dub.
- **Kiểm thử Pipeline SCRIPT_TO_VIDEO**:
  - Kiểm tra độ phủ của lời đọc (`narration` coverage) trong phân đoạn kịch bản, không bị mất văn bản gốc.
  - Kiểm tra Review Gate (`script_review_required = 1`): Dự án dừng lại ở trạng thái `queued` chờ duyệt trước khi sinh media.
- **Kiểm thử Resumable Upload**: Kiểm tra cơ chế gửi chunk, phát hiện lệch offset (`OFFSET_MISMATCH`) và hoàn tất tải lên với băm SHA-256.
