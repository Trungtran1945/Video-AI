# MASTER PROMPT — Vòng cải tiến định kỳ #4 — Video_AI

> File được tạo bởi automation định kỳ ngày **2026-11-25** (lần chạy thứ 2 trong ngày).
> Automation **chỉ đọc** codebase và **chỉ ghi file này**; không code, cấu hình hay luồng hệ thống nào bị thay đổi trong lần chạy này.
> Đây là **một Master prompt duy nhất**, self-contained, dành cho kỹ sư/agent triển khai tiếp.

---

## 0. VAI TRÒ & RÀNG BUỘC

- Đọc root [`AGENTS.md`](../AGENTS.md) trước khi đụng vào code; giữ Karpathy: think first, simplicity first, surgical changes, goal-driven.
- **Không tự ý** `git commit`, `git push`, `git merge`; cấm `git reset --hard`, `git clean -fd`. Không đọc/log secrets, không sửa `.env`, auth, CORS hay validation để làm test xanh.
- **Cây làm việc KHÔNG sạch:** **142 path thay đổi** (trong đó 139 modified/deleted + 3 untracked: `backend/scripts/archive/`, `backend/scripts/check-legacy-artifacts.mjs`, `backend/tests/docsIntegrityGuard.test.mjs`). Đây là việc của tác vụ trước — **chỉ đọc/đánh giá, không ghi đè, không dọn, không commit**.
- Gate bắt buộc cho mọi thay đổi mới: `npm test`, `npm run check:docs`, `npm run lint`, `npm run build`.

---

## 1. SNAPSHOT ĐỐI CHIẾU (2026-11-25, lần 2)

| Hạng mục | Kết quả thực tế |
|---|---|
| Git | `main` = `dcc5b01` (fix TTS checkpoint / isTtsActive / mask preview), trước đó `c239c35`, `d821335`. **+142 path chưa commit**, `git diff --check` sạch |
| Backend test | **226/226 file PASS** — `ALL TEST FILES PASS` |
| Frontend lint | PASS |
| Frontend test | **30/30 PASS**, 4 file unit test |
| Frontend build | PASS — chunk lớn nhất `ProjectDetail 257 kB` / `index 213 kB`, không cảnh báo >500 kB |
| Docs guard | `npm run check:docs` PASS — 18 file, mode matrix, pipeline matrix 4 mode |
| Legacy guard | `npm run check:legacy` PASS — 399 file active sạch `sql.js`/`DB_PATH`/.db literals |
| CI | Có `Docs integrity guard`, `Legacy SQLite artifacts guard`, backend + frontend `npm test` |
| Redis local | **Vẫn fail**: `ECONNREFUSED 127.0.0.1:6379` |
| FFmpeg / ffprobe | `9.0.1-full_build-www.gyan.dev` — OK |
| PostgreSQL | OK; migration 001/002/003 applied, seed admin thành công |
| Provider logs | Hết 503 thật; còn `NO_PROVIDER_AVAILABLE` từ mock (có chủ đích) |

---

## 2. ĐÃ GIẢI QUYẾT TỪ VÒNG #3

| Vòng 3 | Trạng thái hiện tại |
|---|---|
| `save()` ghi file đồng bộ trên mọi write | Đã đổi sang `SELECT 1` probe; write result driving health (`recordPersistenceSuccess/Failure`) |
| Tàn dư SQLite trong test/scripts | Đã dọn; 10 script chuyển vào `backend/scripts/archive/` (có README), guard mới quét 399 file |
| Docs guard hẹp | Đã mở rộng: mode matrix + pipeline matrix + legacy artifacts |
| Root AGENTS pipeline list | Đã cập nhật đủ 4 chuỗi stage |
| 12 file Phase A–D chưa commit | Đã commit thành `dcc5b01` |
| Provenance fallback | Đã có log rõ `provenanceRelaxed=true` trong `outputService.js` |

---

## 3. PHÁT HIỆN MỚI (ưu tiên + ước lượng công sức)

### P1 — Khối dọn dẹp 142 path đang chưa commit
- `git diff --stat`: 139 file thay đổi / xoá, 1267 insertions, 1479 deletions; kèm 3 path untracked. Dù gate local xanh, khối diff quá lớn dễ gây conflict khi rebase và có thể mất work nếu đổi máy/session. Cần human review + quyết định đóng gói (tách "persistence refactor" / "legacy cleanup" / "guard tests" thành PR riêng nếu có thể).
- **Ước lượng:** 30–60 phút review + quyết định commit (không thuộc quyền automation).

### P2 — `outputService.js` chuyển từ "im lặng bỏ qua" sang "throw" với dữ liệu provenance hư
- `backend/src/services/outputService.js:53-67`: trước đây `JSON.parse` lỗi hoặc snapshot hư → `return` (bỏ qua guard); nay **throw** `Output provenance check failed...`.
- Đây là cải tiến đúng về mặt an toàn dữ liệu, nhưng với project cũ có `generation_jobs.result` corrupt, tạo output có thể fail cứng mà không có đường sửa/ recovery rõ ràng cho user. Cần quyết định sản phẩm: throw kèm mã lỗi ổn định + hướng dẫn sửa, hoặc chế độ "quarantine + allow với cờ" cho legacy.
- **Ước lượng:** 2–3 giờ (kèm migration/_backfill_ hoặc script audit dữ liệu cũ).

### P2 — `provenanceRelaxed` mới chỉ nằm ở console log
- `outputService.js` ghi `console.warn(... provenanceRelaxed=true ...)`, nhưng chưa đưa cờ này vào `job.result` hay response API như đề xuất vòng trước → UI/QA vẫn không thấy trạng thái "guard được nới" theo cách có cấu trúc.
- **Ước lượng:** 45–90 phút.

### P2 — Bộ phân loại lỗi persistence có thể đếm nhầm lỗi không phải DB
- `backend/src/db/query.js:24-41` `isPersistenceFailureError()`: mọi error có `code` không phải SQLSTATE 5 ký tự và không nằm trong allowlist đều trả `true` — kể cả error thuần ứng dụng có `code = ''`. Trong `executePoolWrite` chỉ bắt lỗi từ `pool.query`, nên rủi ro thấp; nhưng `withTransaction` dùng chung hàm này và chỉ ghi nhận khi `err === lastClientQueryError`, nên cần test ma trận để khoá hành vi.
- Chưa có test rõ cho: SQLSTATE `23505` (unique) / `42P01` (missing table) / `25006` (read-only) → không nên tăng failure counter; `ECONNREFUSED` / timeout → nên tăng; lỗi từ `fn(tx)` → không tăng; recovery từ DEGRADED → `HEALTHY`.
- **Ước lượng:** 2–3 giờ.

### P2 — Root `AGENTS.md` lại lệch nhẹ: "Unit tests: 3 files" trong khi đã có 4 file / 30 test
- Docs guard kiểm tra mode + pipeline + `sql.js`, nhưng **không** kiểm tra số file test hay số script. Cần cập nhật dòng đó và (nếu muốn) thêm rule guard tối thiểu.
- **Ước lượng:** 20–40 phút.

### P3 — Redis vẫn không có locally
- Dù đã có `ensure-redis.mjs` + hướng dẫn compose, lần này vẫn `ECONNREFUSED`. Mọi pipeline E2E liên quan queue chỉ chạy ở chế độ degrade; cần ghi rõ SKIP/BLOCKED trong báo cáo thay vì mặc định "đã test queue".
- **Ước lượng:** 15–30 phút nếu bật được `docker compose up -d redis`.

---

## 4. NHIỆM VỤ CẦN THỰC HIỆN (Master Prompt)

> Sao chép khối dưới làm prompt cho agent triển khai. Giữ thứ tự ưu tiên; mỗi bước có tiêu chí riêng.

**Bước 1 — Chốt khối dọn dẹp (P1)**
1. Chạy lại: `cd backend && npm run lint && npm test && npm run check:docs`, `cd frontend && npm run lint && npm test && npm run build`, `git diff --check`.
2. `git status --short` + `git diff --stat` → trình human 142 path; đề xuất tách PR theo 3 nhóm: persistence refactor, legacy cleanup/archive, guard tests.
3. Đọc `backend/scripts/archive/README.md` để đảm bảo lý do archive và cách phục hồi được ghi rõ; kiểm tra archive không bị đóng gói vào Docker image (`.dockerignore`).
4. **Không commit/push.** Tiêu chí xong: gate xanh + human đã duyệt diff.

**Bước 2 — Quyết định chính sách provenance hư (P2)**
1. Đọc kỹ `outputService.js:35-90` và các test `revisionProvenance.test.mjs`, `summaryProvenance.test.mjs`.
2. Định nghĩa mã lỗi ổn định (ví dụ `PROVENANCE_DATA_CORRUPT`) kèm thông báo hướng dẫn sửa `generation_jobs.result`; nếu chọn cơ chế quarantine, phải có cờ và test chứng minh guard vẫn chặn mismatch thật.
3. Đưa `provenanceRelaxed` vào `job.result`/phản hồi API có cấu trúc (không chỉ console).
4. **Tiêu chí xong:** có test cho 3 trường hợp: snapshot hư, legacy thiếu snapshot, snapshot mismatch thật vẫn throw; UI/API thấy cờ nới guard.

**Bước 3 — Khoá hành vi phân loại lỗi DB (P2)**
1. Thêm test unit cho `isPersistenceFailureError()` với bảng mã: `23505`, `42P01`, `25006`, `40001`, `ECONNREFUSED`, `undefined`, `''`.
2. Thêm test tích hợp cho `withTransaction`: lỗi do `fn(tx)` ném ra **không** tăng counter; lỗi `pool.connect` / `COMMIT` có tăng; sau `recordPersistenceSuccess()` trạng thái về `HEALTHY`.
3. **Tiêu chí xong:** `npm test` xanh; `database.persistenceState` phản ánh đúng 5 kịch bản trên.

**Bước 4 — Sửa doc test count (P2)**
1. Cập nhật root `AGENTS.md`: "Unit tests: 4 files under `src/**/*.test.js` (30 tests)". Cân nhắc thêm rule vào `check-docs-integrity.mjs` nếu muốn tự động.
2. **Tiêu chí xong:** `npm run check:docs` PASS và con số khớp thực tế.

**Bước 5 — Redis preflight (P3)**
1. Probe `npm run check:redis`. Nếu được phép, `docker compose up -d redis` rồi chạy lại subset test dùng queue; nếu không, ghi rõ `BLOCKED: Redis unavailable` trong báo cáo và không tuyên bố đã test queue.
2. **Tiêu chí xong:** có bằng chứng probe thực tế trong báo cáo.

**Bước 6 — Verification gate cuối (bắt buộc)**
```
cd backend  && npm run lint && npm test && npm run check:docs && npm run check:redis
cd frontend && npm run lint && npm test && npm run build
git diff --check
git status --short
```
Ghi kết quả thực tế (kể cả SKIP/BLOCKED). **Không commit/push** khi chưa có yêu cầu rõ ràng.

---

## 5. GIẢ ĐỊNH & GIỚI HẠN

- 142 path thay đổi thuộc về tác vụ dọn dẹp trước; automation không biết ý định commit của người dùng nên chỉ báo cáo, không dọn dẹp.
- Kết luận "đã giải quyết" ở mục 2 dựa trên test/grep local; CI GitHub chưa được xác nhận lại sau `dcc5b01` và khối diff hiện tại.
- Redis/FFmpeg/PostgreSQL đều được probe thực tế trong lần này; không giả định service có sẵn.
- Đọc file `.md`/.txt bằng PowerShell mặc định có thể ra mojibake do encoding console; nội dung file là UTF-8 hợp lệ (đã kiểm chứng bằng trình đọc UTF-8).
- Không có secrets nào bị đọc hay log; không có code hay luồng hệ thống nào bị automation thay đổi.
