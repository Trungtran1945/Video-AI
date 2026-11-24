# MASTER PROMPT — Vòng cải tiến định kỳ #2 — Video_AI

> File được tạo bởi automation định kỳ, lần rà soát thứ 2 trong ngày **2026-11-24**.
> Automation **chỉ đọc** codebase và **chỉ ghi file này**; không có code, cấu hình hay luồng hệ thống nào bị thay đổi trong lần chạy này.
> Đây là **một Master prompt duy nhất**, self-contained, dành cho kỹ sư/agent triển khai tiếp.

---

## 0. VAI TRÒ & RÀNG BUỘC

- Đọc root [`AGENTS.md`](../AGENTS.md) trước khi đụng vào code; giữ 4 nguyên tắc Karpathy (think first, simplicity first, surgical changes, goal-driven).
- **Không tự ý** `git commit`, `git push`, `git merge`; cấm `git reset --hard`, `git clean -fd`. Không đọc/log secrets, không sửa `.env`, không nới auth/CORS/validation để làm test xanh.
- **Tình trạng cây làm việc hiện tại: KHÔNG sạch.** Có 25 file modified + 6 file untracked do tác vụ trước (triển khai vòng #1) để lại, chưa commit. Đây là tài liệu của người khác — **đọc và đánh giá, không ghi đè, không dọn dẹp, không commit** khi chưa có yêu cầu rõ ràng.
- Mọi thay đổi mới phải có bằng chứng `npm test` / `npm run lint` / `npm run build` / `npm run check:docs`. Không sinh placeholder/TODO code.

---

## 1. SNAPSHOT ĐỐI CHIẾU (lần này)

| Hạng mục | Kết quả thực tế |
|---|---|
| Git | `main` @ `5227d69` + **25 file modified, 6 file untracked** (chưa commit) |
| Backend test | **223/223 file PASS** — `ALL TEST FILES PASS` (tăng từ 221 → 223: thêm `healthQueueState`, `providerIsolation`) |
| Frontend lint | PASS |
| Frontend test | **20/20 PASS** (3 file unit test, đã vào CI) |
| Frontend build | PASS — **đã chia chunk**, lớn nhất `ProjectDetail 255 kB` / `index 213 kB`, **không còn cảnh báo >500 kB** |
| Docs guard | `npm run check:docs` → PASS, 16 file active sạch `sql.js`/`data.db` |
| Redis local | **Vẫn chạy không được**: `ECONNREFUSED 127.0.0.1:6379` |
| FFmpeg / ffprobe | `9.0.1-full_build-www.gyan.dev` — OK |
| PostgreSQL | OK; migration 001/002/003 applied, seed admin thành công |
| Provider logs | Đã hết `[Gemini] transient (503)`; còn `NO_PROVIDER_AVAILABLE` từ mock failure (có chủ đích) |

---

## 2. ĐÃ GIẢI QUYẾT TỪ VÒNG #1 (ghi nhận để không làm lại)

| Vòng 1 | Trạng thái hiện tại |
|---|---|
| P0 browser test login lỗi thời | Đã sửa `loginPageBrowser.test.mjs` + `Login.jsx` (`data-testid`); backend test xanh |
| P1 queue health | Đã thêm `src/routes/v1/health.js`, `QUEUE_STATES`, `QUEUE_REQUIRED`, `ensure-redis.mjs`, test liên quan |
| P1 spec drift | Đã cập nhật ~10 file docs, re-encode, thêm `check-docs-integrity.mjs`; guard PASS |
| P2 bundle 1,167 kB | Đã lazy-load route + `manualChunks`; chunk lớn nhất 255 kB |
| P2 frontend test không ở CI | Đã thêm bước `npm test` vào `ci.yml`; docs đã khớp |
| P3 provider thật trong test | Đã có TestGuard + `DEFAULT_PROVIDER_MODE=mock`, hết log 503 thật |

---

## 3. PHÁT HIỆN MỚI (ưu tiên + ước lượng công sức)

### P1 — Khối thay đổi lớn đang chưa được commit (rủi ro vận hành, ưu tiên cao nhất)
- 25 file modified + 6 file untracked (`health.js`, `healthQueueState.test.mjs`, `providerIsolation.test.mjs`, `ensure-redis.mjs`, `check-docs-integrity.mjs`, `task.md`) + `media_composer_studio.png`.
- Đã tự kiểm chứng local xanh toàn bộ gate, nhưng nếu máy/review session mất trước khi commit thì toàn bộ công việc vòng #1 có thể trôi đi; đồng thời khó tách diff khi reviewer looking vào PR.
- **Ước lượng:** 10–20 phút để human review diff + quyết định commit/đóng gói (không thuộc quyền automation).

### P1 — Docs guard có script nhưng CI không gọi
- `backend/package.json` có `check:docs`, script `check-docs-integrity.mjs` chạy PASS, nhưng `.github/workflows/ci.yml` **không có bước nào gọi nó** (đã grep: không có `check:docs`). Guard hiện chỉ chạy khi nhớ gọi tay → không ngăn tái diễn spec drift.
- **Ước lượng:** 15–30 phút.

### P1 — Hai nguồn sự thật cho `/health` và `/ready`
- `backend/server.js:91-170` tự build payload `/health` + `/ready`; đồng thời `backend/src/routes/v1/health.js` cũng build `buildHealthResponse()` / `buildReadyResponse()` và được mount tại `src/routes/v1/index.js:50` (`/api/v1/health`). Hai bộ logic trùng lặp, payload **không đồng nhất**: bản router có `queueState` ở top-level, bản server thì không; bản server có `cleanup`, `writes`, `auth`, bản router có fallback cứng.
- Comment tại `server.js:141` đã **lỗi thời**: vẫn viết "Redis is reported but never gates readiness", trong khi code ngay dưới đã gate readiness khi `QUEUE_REQUIRED`/production.
- Rủi ro: sửa một chỗ, quên chỗ kia → orchestrator đọc trạng thái sai.
- **Ước lượng:** 2–4 giờ (gồm test parity).

### P2 — Phạm vi docs guard còn hẹp
- `check-docs-integrity.mjs` chỉ quét `Video_AI_docs/`, loại trừ `task.md`, chỉ chặn `sql.js` và `data.db`; **không** chặn `AI_VIDEO`, không quét root `AGENTS.md` / `README.md`, không kiểm tra mode matrix.
- **Ước lượng:** 1–2 giờ.

### P2 — API health có trường thừa / giá trị cứng / trạng thái mock có thể lọt production
- `queueState` vừa nằm top-level vừa nằm trong `queue{}`; `durableCleanup: 'available'` và `refreshFallbackStats` fallback là hard-code.
- `setMockQueueState()` trong `health.js:18-20` là module-level global, không có guard `NODE_ENV === 'test'` — nếu được gọi ngoài test sẽ làm `/health` báo sai. Nên tách injectable dependency hoặc guard môi trường.
- **Ước lượng:** 1–2 giờ.

### P2 — Redis vẫn thiếu locally, nhưng production giờ gate readiness
- `isQueueRequired()` mặc định `true` khi `NODE_ENV=production` → `/ready` trả 503 nếu Redis `UNAVAILABLE`. Đây là hành vi mới, cần xác nhận `docker-compose.yml` (service `redis` + `worker`) và docs triển khai đã phản ánh đúng, tránh deploy lên mà pod không bao giờ ready.
- **Ước lượng:** 30–60 phút kiểm chứng + cập nhật docs.

### P3 — Vệ sinh nhỏ
- `git diff --check` báo trailing whitespace tại `Video_AI_docs/docs/10_TASKS.md:9`.
- `media_composer_studio.png` vẫn là artifact không theo dõi do browser test sinh ra; cần quyết định đưa vào `.gitignore` hay giữ làm evidence.
- **Ước lượng:** 15 phút.

---

## 4. NHIỆM VỤ CẦN THỰC HIỆN (Master Prompt)

> Sao chép khối dưới làm prompt cho agent triển khai. Giữ thứ tự ưu tiên; mỗi bước có tiêu chí xong riêng.

**Bước 1 — Chốt khối thay đổi hiện tại (P1)**
1. Chạy lại toàn bộ gate để có bằng chứng mới nhất: `cd backend && npm run lint && npm test && npm run check:docs`; `cd frontend && npm run lint && npm test && npm run build`.
2. Đọc `git diff --stat`, `git diff --check`, `git status --short`; liệt kê rõ 31 file thay đổi cho người duyệt.
3. **Không commit/push.** Trình bày cho human quyết định: commit một lần hay tách PR (P0 fix / health+redis / docs / bundle / provider isolation).
4. **Tiêu chí xong:** có báo cáo gate xanh + danh sách file được human xác nhận; cây làm việc không bị automation đụng vào.

**Bước 2 — Đưa docs guard vào CI (P1)**
1. Thêm vào `.github/workflows/ci.yml` sau bước lint backend:
   `- name: Docs integrity guard` / `run: cd backend && npm run check:docs`.
2. Cân nhắc thêm `npm run ensure:redis` làm bước preflight informative (không fail job khi Redis dùng ephemeral), ghi rõ trong README.
3. **Tiêu chí xong:** CI chạy guard; cố tình thêm từ `sql.js` vào một file active trong `Video_AI_docs` thì job phải đỏ (kiểm chứng bằng test trên branch phụ, rồi hoàn nguyên).

**Bước 3 — Gộp hai health endpoint về một nguồn sự thật (P1)**
1. Chọn `backend/src/routes/v1/health.js` làm nguồn duy nhất. Trong `server.js`, thay đoạn build payload bằng `buildHealthResponse()` / `buildReadyResponse()`; giữ nguyên contract hiện có (`status`, `database.persistenceState`, `queue`, `cleanup`, `writes`, `auth`) để không vỡ monitor/orchestrator.
2. Sửa comment lỗi thời tại `server.js:141` để phản ánh đúng: Redis/report-only ở dev, gate readiness khi `QUEUE_REQUIRED=true` hoặc production.
3. Quyết định một field canonical cho trạng thái queue (`queue.state` **hoặc** top-level `queueState`) — giữ một, ghi chú migration nếu bỏ field cũ.
4. Viết test parity: gọi handler `/health` và `/ready` của server lẫn router, assert cùng giá trị trong 3 trạng thái queue (HEALTHY/DEGRADED/UNAVAILABLE) + DB WRITE_BLOCKED.
5. **Tiêu chí xong:** `npm test` xanh, không còn định nghĩa trùng `QUEUE_STATES`, comment khớp code.

**Bước 4 — Mở rộng docs guard (P2)**
1. Quét thêm root `AGENTS.md`, root `README.md`; chặn thêm token `AI_VIDEO` trừ khi nằm trong đoạn giải thích alias có chủ đích (dùng allowlist rõ ràng).
2. Thêm kiểm tra mode matrix: các file active phải liệt kê đúng `SUMMARY, TRANSLATE_DUB, SCRIPT_TO_VIDEO, MEDIA_COMPOSER` (+ alias `AI_VIDEO` được ghi chú).
3. **Tiêu chí xong:** guard vẫn PASS trên tree hiện tại; test guard bắt được 1 violation mẫu.

**Bước 5 — Làm sạch API health & mock state (P2)**
1. Bỏ `setMockQueueState` global hoặc chỉ cho phép khi `NODE_ENV === 'test'`; ưu tiên truyền state qua opts đã có (`getQueueHealth(opts.forceState)`).
2. Thay các hard-code `durableCleanup: 'available'`, `refreshFallbackStats` fallback bằng giá trị lấy từ service thật hoặc ghi rõ "deprecated/unknown" thay vì "available".
3. **Tiêu chí xong:** test `healthQueueState` vẫn xanh; không còn field trùng lặp không cần thiết.

**Bước 6 — Xác nhận Redis/production readiness (P2)**
1. Probe `npm run check:redis`; nếu vẫn fail, bật `docker compose up -d redis` (chỉ khi được phép) và chạy lại smoke test. Nếu không bật được, ghi rõ SKIP/BLOCKED, không giả định.
2. Kiểm tra `docker-compose.yml` có services `redis` + `worker`, và docs triển khai nêu rõ `QUEUE_REQUIRED` mặc định production. Thêm 1 dòng cảnh báo vào README nếu còn thiếu.
3. **Tiêu chí xong:** có bằng chứng `/ready` trả 200 khi Redis up và 503 khi `QUEUE_REQUIRED=true` + Redis down (đã có test đơn vị, cần thêm smoke nếu chưa có).

**Bước 7 — Vệ sinh & verification gate cuối (P3 + bắt buộc)**
1. Sửa trailing whitespace tại `Video_AI_docs/docs/10_TASKS.md:9`; quyết định artifact `media_composer_studio.png` (gitignore hay giữ evidence).
2. Chạy lại:
```
cd backend  && npm run lint && npm test && npm run check:docs   # check:redis có thể FAIL — ghi rõ
cd frontend && npm run lint && npm test && npm run build
git diff --check
git status --short
```
3. **Tiêu chí xong:** mọi lệnh xanh (trừ Redis được ghi nhận BLOCKED), không có file ngoài phạm vi bị sửa, không commit/push.

---

## 5. GIẢ ĐỊNH & GIỚI HẠN

- Cây làm việc bẩn thuộc về tác vụ triển khai vòng #1; automation không biết ý định commit của người dùng, nên chỉ báo cáo, không dọn.
- Kết luận "đã giải quyết" ở mục 2 dựa trên kết quả test/grep thực tế tại máy này; CI trên GitHub chưa được xác nhận (không có quyền đẩy). Cần human xác nhận lại sau khi commit.
- Redis có thể đã chạy ở môi trường khác — luôn probe lại, đừng giả định.
- Không có secrets nào bị đọc hay log trong lần rà soát này. Không có code hay luồng hệ thống nào bị automation thay đổi.
