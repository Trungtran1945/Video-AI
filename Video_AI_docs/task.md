# MASTER PROMPT — Vòng cải tiến định kỳ #3 — Video_AI

> File được tạo bởi automation định kỳ ngày **2026-11-25**.
> Automation **chỉ đọc** codebase và **chỉ ghi file này**; không code, cấu hình hay luồng hệ thống nào bị thay đổi trong lần chạy này.
> Đây là **một Master prompt duy nhất**, self-contained, dành cho kỹ sư/agent triển khai tiếp.

---

## 0. VAI TRÒ & RÀNG BUỘC

- Đọc root [`AGENTS.md`](../AGENTS.md) trước khi đụng vào code; giữ 4 nguyên tắc Karpathy (think first, simplicity first, surgical changes, goal-driven).
- **Không tự ý** `git commit`, `git push`, `git merge`; cấm `git reset --hard`, `git clean -fd`. Không đọc/log secrets, không sửa `.env`, auth, CORS hay validation để làm test xanh.
- **Cây làm việc hiện tại KHÔNG sạch:** 10 file modified + 2 file untracked (`maskApproveRender.test.mjs`, `maskEditor.test.js`) do tác vụ `task.txt` (Phase A–D) để lại, chưa commit. Đây là việc của người khác — **chỉ đọc/đánh giá, không ghi đè, không dọn, không commit**.
- Mọi thay đổi mới phải có bằng chứng: `npm test`, `npm run check:docs`, `npm run lint`, `npm run build`. Không sinh placeholder/TODO.

---

## 1. SNAPSHOT ĐỐI CHIẾU (2026-11-25)

| Hạng mục | Kết quả thực tế |
|---|---|
| Git | `main` = `c239c35` (fix dubbing), trước đó `d821335` (periodic improvements). **+10 modified, +2 untracked, chưa commit** |
| Backend test | **225/225 file PASS** — `ALL TEST FILES PASS` |
| Frontend lint | PASS |
| Frontend test | **30/30 PASS** (tăng từ 20: thêm 10 test cho `maskEditor.test.js`) |
| Frontend build | PASS — chunk lớn nhất `ProjectDetail 257 kB`, không cảnh báo >500 kB |
| Docs guard | `npm run check:docs` PASS — 18 file, đã chặn `sql.js`/`data.db`/`AI_VIDEO` trái phép và kiểm tra mode matrix 4 mode |
| CI | Đã có `check:docs` (dòng 71), backend `npm test` (77), frontend `npm test` (88) |
| Redis local | **Vẫn fail**: `ECONNREFUSED 127.0.0.1:6379` |
| FFmpeg / ffprobe | `9.0.1-full_build-www.gyan.dev` — OK |
| PostgreSQL | OK; migration 001/002/003 applied, seed admin thành công |
| Provider logs | Hết `[Gemini] transient (503)`; còn `NO_PROVIDER_AVAILABLE` từ mock failure (có chủ đích) |

---

## 2. ĐÃ GIẢI QUYẾT TỪ VÒNG #2 (ghi nhận, không làm lại)

| Vòng 2 | Trạng thái hiện tại |
|---|---|
| Khối thay đổi lớn chưa commit | Đã commit thành `d821335` + `c239c35` |
| CI chưa chạy docs guard | Đã thêm bước `check:docs` và `frontend npm test` |
| Hai `/health` trùng lặp | Đã gộp; có `healthEndpointParity.test.mjs` (348 dòng) |
| Docs guard hẹp | Đã mở rộng: chặn `AI_VIDEO`, kiểm tra 4 mode, 18 file |
| Trailing whitespace / artifact | Đã dọn (commit `d821335` cập nhật `.gitignore`) |
| Phase A–D của `task.txt` | Đang triển khai ở working tree; local gate xanh, chưa commit |

---

## 3. PHÁT HIỆN MỚI (ưu tiên + ước lượng công sức)

### P1 — `save()` vẫn thực hiện file I/O đồng bộ trên **mọi thao tác ghi DB**
- `backend/src/db.js:116-127`: `save()` gọi `fs.writeFileSync(path.join(os.tmpdir(), '.vidai_db_probe'), 'ok')` — di sản của cơ chế snapshot SQLite, nay không còn là persistence thật (DB đã là PostgreSQL qua `pg.Pool`).
- `backend/src/db/query.js` gọi `checkPersistenceGate()` ở **7 vị trí** (`run`, `runAffected`, `runReturningOne`, `insert`, `updateById`, `commit`, ...) và hàm này luôn gọi `save()` (dòng 18-33).
- Hệ quả: mỗi INSERT/UPDATE/commit trong pipeline và API đều chạy một lần ghi file đồng bộ; nếu temp dir đầy/permissions thay đổi, `consecutiveSaveFailures` tăng và DB bị coi là `DEGRADED`/`WRITE_BLOCKED` dù PostgreSQL vẫn hoàn toàn khoẻ. Đây là điểm nghẽn hiệu năng **và** tín hiệu sức khoẻ sai.
- **Ước lượng:** 2–4 giờ (đổi probe sang `pool.query('SELECT 1')` hoặc tách riêng health check, giữ API tương thích, cập nhật test persistence).

### P1 — Tàn dư SQLite trong code/test/scripts không nằm trong phạm vi docs guard
- Nhiều test backend vẫn set `process.env.DB_PATH = .../*.db` (đã grep thấy ít nhất 20 file, ví dụ `adminQueueMetrics`, `asrCacheSemantics`, `atomicClaim`, `composer*`, và file mới `maskApproveRender.test.mjs:20`). `src/db/query.js` và `src/db.js` **không đọc `DB_PATH`** — biến này là no-op, tạo cảm giác giả về test isolation (thực tế các test dùng chung `DATABASE_URL`).
- `backend/scripts/` vẫn có `audit_sqlite.mjs`, `inspectSqlite.mjs`, `detailed_schema_dump.mjs`, `inspect_json_samples.mjs`, `inspect_orphans.mjs` — đều `import initSqlJs from 'sql.js'` trong khi `backend/package.json` **không còn khai báo dependency `sql.js`**. Các script này sẽ fail ngay khi chạy, nhưng không bao giờ được CI gọi nên không ai phát hiện.
- `check-docs-integrity.mjs` chỉ quét docs → không bắt được drift trong code/scripts/tests.
- **Ước lượng:** 3–5 giờ (dọn/lưu trữ script, thay `DB_PATH` bằng schema-per-test hoặc transaction rollback, mở rộng guard sang `backend/scripts` + test config).

### P1 — Khối Phase A–D đang chưa commit
- `task.txt` đánh dấu tất cả `[x]` HOÀN THÀNH và local gate xanh, nhưng 12 file vẫn ở trạng thái modified/untracked. Rủi ro mất work khi đổi máy/session; reviewer cũng khó tách diff.
- Cần human review trước khi commit; automation không có quyền commit/push.
- **Ước lượng:** 15–30 phút review + quyết định đóng gói (1 commit hay tách PR).

### P2 — Task docs tự xung đột: `task.txt` gắn HOÀN THÀNH trong khi code chưa vào git
- `Video_AI_docs/task.txt:3` ghi `Trạng thái: HOÀN THÀNH [DONE]` nhưng nội dung vẫn là kế hoạch follow-up và code tương ứng chưa commit. Nếu automation/chạy tiếp đọc nhầm sẽ bỏ sót việc cần làm.
- Đề xuất: tách rõ "plan" và "status", gắn commit hash thực tế vào từng phase thay vì checkbox `[x]` sớm.
- **Ước lượng:** 30–45 phút.

### P2 — Root `AGENTS.md` chưa theo kịp 4 mode
- Sau cập nhật, root `AGENTS.md` liệt kê `SUMMARY, TRANSLATE_DUB, SCRIPT_TO_VIDEO, MEDIA_COMPOSER`, nhưng mục **Pipeline stages** vẫn chỉ mô tả chuỗi `dub*` và `summary*`, thiếu `composer.ingest → composer.prepare → composer.render` và `script.*` (các stage này có thật trong `backend/src/pipeline/stages/`). Docs guard hiện kiểm tra mode matrix nhưng **không** kiểm tra pipeline list của root `AGENTS.md`.
- **Ước lượng:** 45–90 phút (cập nhật docs + thêm rule guard nếu muốn).

### P2 — Provenance guard có đường fallback âm thầm
- Log test runner: `[GenerationProvenance] ... dub.ttsAlign has no frozen snapshot (state=absent) — falling back to current transcript revision 1`. Fallback giúp resume không chết, nhưng nếu snapshot bị mất do lỗi thật thì hệ thống vẫn tiếp tục mà không có cảnh báo ở cấp API/UI. Cần log rõ ràng hơn (đã có log) + có thể đánh dấu `provenanceRelaxed=true` vào job.result để QA thấy.
- **Ước lượng:** 1–2 giờ.

### P3 — Test `maskApproveRender` dùng biến môi trường lỗi thời
- `backend/tests/maskApproveRender.test.mjs:20-21` set `DB_PATH` và `STORAGE_DIR` nhưng hai biến này không có tác dụng; test vẫn ghi vào PostgreSQL dùng chung. Nên dùng database/schema riêng hoặc dọn dẹp row sau test để tránh nhiễu giữa 225 file chạy song song.
- **Ước lượng:** 30–60 phút (gộp vào P1 tàn dư SQLite).

---

## 4. NHIỆM VỤ CẦN THỰC HIỆN (Master Prompt)

> Sao chép khối dưới làm prompt cho agent triển khai. Giữ thứ tự ưu tiên; mỗi bước có tiêu chí xong riêng.

**Bước 1 — Chốt Phase A–D (P1)**
1. Chạy lại gate đầy đủ: `cd backend && npm run lint && npm test && npm run check:docs`; `cd frontend && npm run lint && npm test && npm run build`.
2. `git diff --stat`, `git diff --check`, `git status --short` → liệt kê 12 file thay đổi cho human.
3. Đọc đối chiếu `Video_AI_docs/task.txt` với diff để xác nhận từng `[x]` có bằng chứng test thật (đặc biệt Phase A: runner checkpoint resume, Phase B: `isTtsActive`, Phase C: mask approve→render).
4. **Không commit/push.** Trình human quyết định commit hay tách PR.
5. **Tiêu chí xong:** gate xanh + human đã xác nhận diff; automation không đụng vào các file này.

**Bước 2 — Bỏ file I/O khỏi `save()` (P1)**
1. Trong `backend/src/db.js`, định nghĩa lại `save()` thành no-op tương thích hoặc probe qua `getPool().query('SELECT 1')` (không `writeFileSync`). Giữ nguyên tên export để `query.js` và các caller khác không vỡ.
2. Nếu vẫn muốn đo "save failures", đổi nguồn tín hiệu sang kết quả query PostgreSQL thật; cập nhật `database.persistenceState` cho đúng.
3. Thêm/sửa test: giả lập temp dir không writable mà DB vẫn OK → `persistenceState` phải vẫn `HEALTHY`; giả lập DB write fail → phải `DEGRADED`/`WRITE_BLOCKED`.
4. **Tiêu chí xong:** `npm test` xanh, không còn `fs.writeFileSync` trong đường ghi DB, `/health` phản ánh đúng trạng thái PostgreSQL.

**Bước 3 — Dọn tàn dư SQLite & làm guard quét cả code (P1)**
1. Xoá hoặc chuyển vào thư mục `archive/` (có README giải thích) 5 script `sql.js` trong `backend/scripts/`; nếu giữ thì phải khai báo dependency hoặc đổi sang đọc schema PostgreSQL.
2. Thay `process.env.DB_PATH = ...` trong các test bằng cơ chế isolation phù hợp với PostgreSQL (schema riêng theo test / truncate có chủ đích / transaction rollback). Ưu tiên làm trước cho file mới `maskApproveRender.test.mjs`, sau đó lan ra các test khác theo đợt.
3. Mở rộng `check-docs-integrity.mjs` (hoặc script mới `check-legacy-artifacts.mjs`) quét cả `backend/scripts/` và phần khai báo env trong `backend/tests/` để bắt `sql.js` / `DB_PATH`. Thêm vào CI.
4. **Tiêu chí xong:** `npm run check:docs` (hoặc guard mới) PASS; không còn khai báo dependency thiếu; test không tạo file `.db` giả.

**Bước 4 — Làm rõ trạng thái task docs (P2)**
1. `Video_AI_docs/task.txt`: đổi tiêu đề trạng thái thành `ĐANG TRIỂN KHAI — chưa commit` cho tới khi có hash commit thật; ghi hash vào từng phase đã xong. Giữ `task.md` là bản Master prompt định kỳ (không gộp hai file).
2. **Tiêu chí xong:** không còn file tự xưng DONE khi code chưa vào git.

**Bước 5 — Cập nhật pipeline list trong root AGENTS.md (P2)**
1. Bổ sung hai chuỗi stage `composer.*` và `script.*` vào mục Pipeline stages cho khớp 4 mode hiện hành; giữ nguyên các mode đã có. Nếu thêm rule vào docs guard, đảm bảo rule không chặn các file archive.
2. **Tiêu chí xong:** `npm run check:docs` PASS; docs guard bắt được violation mẫu nếu thiếu stage.

**Bước 6 — Ghi nhận provenance relaxation (P2)**
1. Khi `buildGenerationSnapshot` rơi vào fallback "no frozen snapshot", đưa cờ `provenanceRelaxed: true` + lý do vào `job.result`/log có cấu trúc để UI/QA thấy; không làm suy yếu guard khi dubbing bật bình thường.
2. **Tiêu chí xong:** có test chứng minh guard vẫn chặn mismatch thật, và fallback được ghi nhận rõ.

**Bước 7 — Verification gate cuối (bắt buộc)**
```
cd backend  && npm run lint && npm test && npm run check:docs && npm run check:redis  # Redis có thể FAIL — ghi rõ
cd frontend && npm run lint && npm test && npm run build
git diff --check
git status --short
```
Ghi kết quả thực tế (kể cả SKIP/BLOCKED) vào báo cáo. **Không commit/push** khi chưa có yêu cầu rõ ràng.

---

## 5. GIẢ ĐỊNH & GIỚI HẠN

- Cây làm việc bẩn thuộc về tác vụ `task.txt` Phase A–D; automation không biết ý định commit của người dùng nên chỉ báo cáo, không dọn dẹp.
- Kết luận "đã giải quyết" ở mục 2 dựa trên test/grep tại máy local; CI GitHub chưa được xác nhận lại sau commit mới nhất.
- Redis có thể đã chạy ở môi trường khác — luôn probe lại, không giả định. FFmpeg/ffprobe và PostgreSQL đã được probe trong lần này.
- Đọc `task.txt` bằng PowerShell mặc định có thể hiện mojibake do encoding console; nội dung file thực tế là UTF-8 hợp lệ (đã kiểm chứng bằng trình đọc UTF-8).
- Không có secrets nào bị đọc hay log trong lần rà soát này. Không có code hay luồng hệ thống nào bị automation thay đổi.
