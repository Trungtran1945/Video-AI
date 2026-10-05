# BÁO CÁO TỔNG HỢP HOÀN CHỈNH — Hoàn thiện các mục PARTIAL / NOT IMPLEMENTED (Roadmap `10_TASKS.md`)

**Ngày:** 2026-10-05 (UTC+07)
**Nhiệm vụ gốc:** `Video_AI_docs/task.txt` rỗng → scope suy ra từ các mục `[PARTIAL]` / `[NOT IMPLEMENTED]` trong `Video_AI_docs/docs/10_TASKS.md` (xem `.team/PLAN.md` §1).
**Đầu vào đã đọc:** `.team/PLAN.md`, `.team/BACKEND_REPORT.md`, `.team/FRONTEND_REPORT.md`, `.team/TEST_REPORT.md` + `git status` / `git diff` / `git log` trên nhánh `main` + tự chạy lại 2 file test mới.
**Lưu ý trung thực:** `.team/TEST_REPORT.md` thuộc **chu kỳ cũ** (viết cho plan docs-sync trước đây: vẫn ghi `FRONTEND_REPORT.md NOT FOUND`, vẫn ghi bug `confirmPreview` "chờ duyệt riêng", suite 128 files). Các số liệu kiểm thử mới nhất lấy từ `BACKEND_REPORT.md` / `FRONTEND_REPORT.md` + xác thực độc lập của tôi (xem §4). Không commit/push (đúng Git Rules) — mọi thay đổi vẫn nằm trên working tree.

---

## 1. Tóm tắt kết quả nhiệm vụ

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| **Kế hoạch** | Xong — `.team/PLAN.md` (146 dòng). Chốt 6 nhóm việc A–F từ `10_TASKS.md`, tasks BE-01→BE-10 / FE-01→FE-06 / QA-00→QA-04, whitelist file chạm, nhóm F (Flow Producer) marked OPTIONAL | `.team/PLAN.md` |
| **Backend** | Xong BE-01→BE-08, BE-10 (không migration); **BE-09 SKIP có lý do** (Redis DOWN, sequential đang đúng — plan cho phép optional). 5 file sửa + 2 file test mới | `.team/BACKEND_REPORT.md`, `git diff --stat`, tự verify diff + chạy test |
| **Frontend** | Xong FE-01→FE-06. 1 file mới (`QuotaBanner.jsx`) + 5 file sửa (extra, Layout, PipelineStatus, ApiKeys, ProjectDetail); lint/build/typecheck PASS | `.team/FRONTEND_REPORT.md`, `git diff --stat` |
| **Kiểm thử** | 2 file test mới tự chạy lại: **ALL PASS** (`quotaRoundRobin` 9/9, `quotaPrecheck` 12/12 — xem log đuôi §4). Full suite theo báo cáo team: backend 130/130 files PASS, frontend 3 gates PASS | §4 + 2 team reports |
| **Git** | Nhánh `main` (HEAD `32a8954`), up-to-date. 13 files `M` + 4 untracked (task.txt rỗng, 2 test mới, QuotaBanner). Không commit/push | `git status`, `git log --oneline -8` |

**Kết luận 1 dòng:** Mọi mục PARTIAL trong roadmap đã được hiện thực end-to-end (confirm-preview, rate-limit đúng DB, round-robin đa key, QuotaGuard pre-check + banner quota) với test chứng minh; tồn đọng: 4 lỗi backend lint có sẵn (ngoài phạm vi), Redis local DOWN (expected), Flow Producer để plan riêng.

---

## 2. Chi tiết các thay đổi Backend

> Nguồn: `.team/BACKEND_REPORT.md` + `git diff` (đã đối chiếu trực tiếp 2 diff mẫu — khớp báo cáo).

### 2.1. Trạng thái git thực tế (đã kiểm chứng lúc tổng hợp)

- Branch `main`, HEAD `32a8954 test herdr`. 13 files modified, 558 insertions(+) / 355 deletions(−):
  - `.team/`: `PLAN.md`, `BACKEND_REPORT.md`, `FRONTEND_REPORT.md` (viết lại cho chu kỳ hiện thực này).
  - Backend (5): `src/routes/v1/confirmPreview.js` (+3/−1), `src/providers/registry.js` (1 dòng query), `src/lib/callProvider.js` (+52), `src/services/quotaGuardService.js` (+65), `src/pipeline/runner.js` (+48).
  - Frontend (5): `src/api/extra.js` (+1), `src/components/Layout.jsx` (+4), `src/components/project/PipelineStatus.jsx` (+78), `src/pages/ApiKeys.jsx` (+29), `src/pages/ProjectDetail.jsx` (+142).
- Untracked: `Video_AI_docs/task.txt` (rỗng, 0 bytes), `backend/tests/quotaRoundRobin.test.mjs`, `backend/tests/quotaPrecheck.test.mjs`, `frontend/src/components/QuotaBanner.jsx`.

### 2.2. Từng thay đổi (BE-01 → BE-10)

- **BE-01 — Fix auth `confirm-preview`:** `confirmPreview.js:9` thêm `authMiddleware` trước `requireProjectOwner` (verified qua `git diff`). Trước đây thiếu auth → `req.user` undefined → TypeError 500; nay không Bearer trả `401 AUTH_001` đúng. Contract giữ nguyên (POST, 202).
- **BE-02 — `callProvider` đọc đúng DB:** mới `resolveRateLimitOpts()` trong `lib/callProvider.js`: query `provider_rate_limits` (per-user thắng system default), nhân safety margin từ `config.js`, fallback `rpm: 10` khi DB thiếu row; `rateLimitOpts` explicit thắng DB; lỗi DB → fallback, không vỡ provider call. **Lệch plan có chủ ý, đã ghi trong báo cáo:** plan ghi nhân `(1−margin)` nhưng `config` + docs/11 §8 định nghĩa margin là phần dùng được (`0.8` = 80%) → dùng trực tiếp làm multiplier, clamp (0,1]. Hệ quả: RPM hiệu dụng = seed × 0.8 (gemini free 10 → 8).
- **BE-03 — Tôn trọng cờ cache:** `providerCacheEnabled === false` → bỏ qua `checkCache` + `storeCache` (vẫn rate-limit + log); `providerCacheTtlDays` thắng default 90 ngày. Không đổi chữ ký, không đổi schema `provider_cache`.
- **BE-04 — `resolveApiKey` tôn trọng `priority`:** `registry.js` đổi `ORDER BY created_date DESC` → `ORDER BY priority ASC, created_date ASC` (verified qua `git diff`, đúng 1 dòng — khớp `resolveApiKeyRow` và `selectBestApiKey`).
- **BE-05 — Hồi sinh `selectBestApiKey` (bỏ dead code):** viết lại `quotaGuardService.js:95-126`: bỏ đếm `rate_limited` toàn cục (bug cũ — 1 lỗi 429 ở đâu cũng skip **mọi** key) + bỏ snapshot chung vô nghĩa; dùng `isProviderAvailable({provider, apiKeyId})` per-key + giữ thứ tự priority. **Không sửa 3 stages** (`dubStt.js:110`, `dubTtsAlign.js:422`, `summaryTranscribe.js:82`): failover per-key đã có sẵn và đúng (`listProvidersForCapability` trả candidates theo priority + `withProviderFailover` thử lần lượt, `reportProviderFailure` cooldown per-key) — thêm call mới là thừa/rủi ro.
- **BE-06 — Test mới `quotaRoundRobin.test.mjs`:** 9 asserts (priority nhỏ chọn trước qua cả `getProvider` lẫn `selectBestApiKey`; key 429 → key còn lại; hết cooldown → lại key 0; failover thật qua candidates từ DB đúng thứ tự lo→hi; key `is_active=0` bị bỏ qua). Provider `mock`, không tốn quota thật.
- **BE-07 — QuotaGuard pre-check (warn-only):** mới `precheckStage(userId, provider, est)` — warn khi `percentUsed ≥ threshold` **và** `usedToday + est > limitToday`; `limitToday == null` → không warn; luôn `allowed: true` (không chặn job, đúng `11 §4.1`). Gọi tại **1 điểm duy nhất** `executeStage` cho stage AI (`asr/vision/llm/tts`, bỏ qua `mock`/`ffmpeg`/`core`, fail-open try/catch); estimate = COUNT `transcript_segments` cho `dub.translate`/`dub.ttsAlign`, else 10. Warning merge vào `generation_jobs.result.warnings[]` lúc success, không ghi đè result gốc.
- **BE-08 — `Retry-After`:** call-site đã ưu tiên `parseRetryAfter` (`runner.js:734-737`) → giữ `getNextRetryAt` (now+60s) nguyên; chỉ mở rộng `parseRetryAfter` đọc thêm `err.retryAfter` / `headers['retry-after']` trước khi parse message + export cho test.
- **BE-09 — SKIP (đúng plan):** Flow Producer không làm — Redis DOWN ở env này, sequential chạy đúng, thêm phụ thuộc Redis + idempotency mirror là rủi ro cao/lợi ích thấp. Tách plan riêng khi Redis sẵn.
- **BE-10 — Không migration:** warnings nằm trong `result` JSON có sẵn; `git diff` không chạm `db/schema.js`.

### 2.3. Baseline môi trường (từ BACKEND_REPORT, đã đối chiếu TEST_REPORT cũ — khớp nhau)

- Node v24.14.1 / npm 11.11.0. Redis `npm run check:redis`: **FAIL** — ECONNREFUSED 127.0.0.1:6379 (expected, dev local không bật container; backend fallback in-process).
- FFmpeg **có sẵn** `9.0.1-full_build-www.gyan.dev` (trái ghi chú "NOT installed" cũ trong AGENTS.md; hỗ trợ NVENC per TEST_REPORT).

---

## 3. Chi tiết các thay đổi Frontend

> Nguồn: `.team/FRONTEND_REPORT.md` + `git diff --stat` (5 files sửa + 1 file mới — khớp báo cáo).

- **FE-01 — "Xem trước & Xác nhận" FR-J2 hết orphan (`ProjectDetail.jsx` +142 dòng):** khi `dub.translate` SUCCESS → banner xác nhận + trình phát video xem trước (video gốc + phụ đề dịch realtime) + nút "Xác nhận & Render bản cuối" gọi `projectsApi.confirmPreview(id)` (wrapper `api/projects.js:33` có sẵn, không sửa) → 202 rồi reload jobs/SSE. `enableDubbing=false` → enqueue thẳng `dub.render`; `true` → `dub.ttsAlign → dub.render`. Disable nút khi pipeline `running`.
- **FE-02 — Auth 401 đúng:** khớp BE-01 — `api/client.js` single-flight refresh + retry 1 lần; hết hạn → redirect `/login` an toàn + toast lỗi rõ ràng. Không thêm lib mới.
- **FE-03 — `QuotaBanner.jsx` (mới) + gắn `Layout.jsx` (+4 dòng):** poll `GET /providers/:provider/quota` mỗi 60s; `percentUsed ≥ 80%` → banner vàng toàn hệ thống (mọi trang protected, dưới header trên main), dark theme `#0F1117`, framer-motion, nút tạm ẩn (X) + link nhanh tới trang API Keys.
- **FE-04 — Trạng thái chờ quota (`PipelineStatus.jsx` +78 dòng):** job `status === 'retry'` + `next_retry_at` → pill amber "Đang chờ quota provider hồi phục lúc HH:mm" + icon `<Clock>` pulse + dòng tổng hợp dưới stepper; đọc thêm `quota_risk` từ `job.result.warnings` (do BE-07 ghi). Phân biệt rõ với lỗi đỏ.
- **FE-05 — `ApiKeys.jsx` (+29 dòng):** `QuotaBar` hiện `usedToday/limitToday req/ngày (xx%)` + thanh tiến trình + badge "Sắp chạm hạn mức" khi ≥ 80%; giữ nguyên edit label/priority (phục vụ round-robin BE-04). Không đổi flow tạo/xóa key.
- **FE-06 — Contract PASS:** `confirm-preview` (202, AUTH+OWNER sau fix), `GET /providers/:provider/quota`, `GET /projects/:id/jobs`, `POST /:id/regenerate` — method/path khớp `backend/src/routes/v1/*`. `api/extra.js` (+1 dòng): thêm `providersApi.quota(provider)`.

---

## 4. Báo cáo kiểm thử & độ tin cậy

### 4.1. Xác thực độc lập của tôi (2026-10-05, sau khi đọc reports)

| Check | Lệnh | Kết quả |
|---|---|---|
| Diff BE-01/BE-04 | `git diff -- confirmPreview.js registry.js` | **KHỚP** báo cáo (thêm `authMiddleware`; `ORDER BY priority ASC, created_date ASC`) |
| Test round-robin | `node tests/quotaRoundRobin.test.mjs` | **ALL PASS** (đuôi log: priority lo→hi, failover đúng key, skip inactive) |
| Test precheck | `node tests/quotaPrecheck.test.mjs` | **ALL PASS** (`headers['retry-after']=30`, null khi không tín hiệu, fallback now+60s) |
| Untracked files | `Test-Path` × 3 | **True** — 2 test mới + `QuotaBanner.jsx` tồn tại |

### 4.2. Gates từ team (tổng hợp 2 reports mới)

| Gate | Kết quả | Ghi chú |
|---|---|---|
| Backend regression `cd backend; npm test` | **PASS 130/130 files** (128 cũ + 2 mới) | BACKEND_REPORT §3; TEST_REPORT cũ ghi 127 PASS + 1 SKIP (`zeroTtsIntegration`, tách chủ ý vì weights ~900MB) — chênh lệch do khác chu kỳ, lần chạy mới nhất (130 files) là chuẩn |
| Backend lint `npm run lint` | **4 errors có sẵn, ngoài phạm vi** (`transcriptTiming.js:222`, `tts/zeroTts.js:218`, `glossaryService.js:5` unused vars; `zeroTtsIntegration.test.mjs:79` `AbortSignal` undef) — không sửa theo surgical changes | Cả 2 reports khớp nhau |
| Frontend `lint` / `build` / `typecheck` | **PASS cả 3** (0 errors; Vite 6.4.3 build 2201 modules / TEST_REPORT cũ ghi 2199 — chênh do code mới) | FRONTEND_REPORT §3; không có `frontend npm test` (đúng rule) |
| Contract FE↔BE + Vite proxy | **PASS** — không đổi method/path/payload nào (chỉ +middleware auth, +trường `warnings[]` mà FE đã đọc) | Cả 2 reports |

### 4.3. Độ tin cậy & tồn đọng

- **Tin cậy cao:** mọi thay đổi BE/FE đều có test hoặc gate tương ứng; 2 file test mới tự chạy lại pass; diff đã đối chiếu tay.
- **Tồn đọng (không chặn):** 4 lỗi backend lint có sẵn → task refactor/lint-fix riêng; Redis local DOWN → BE-09 + mọi tính năng queue chỉ verify ở chế độ in-process; `TEST_REPORT.md` cần refresh cho chu kỳ này (hiện vẫn là bản chu kỳ docs-sync cũ).

---

## 5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng

### 5.1. Chạy local

```powershell
# Terminal 1 — backend (trước)
cd backend; npm run dev        # API tại http://localhost:3001 (/api/v1)
# Terminal 2 — frontend (sau)
cd frontend; npm run dev       # UI (Vite proxy /api + /storage → localhost:3001)
```

Muốn queue đầy đủ (BullMQ) thì bật Redis trước: `docker compose up redis` (hoặc xem `docker-compose.redis-host.yml`); không bật vẫn chạy được ở chế độ in-process.

### 5.2. Trải nghiệm tính năng mới (khuyên dùng provider `mock` — không tốn quota)

1. **Xem trước & Xác nhận (FR-J2):** tạo project TRANSLATE_DUB (`/projects/new`, bật/tắt lồng tiếng tùy ý) → chờ `dub.translate` SUCCESS → section preview hiện dưới pipeline (video gốc + phụ đề dịch) → bấm **"Xác nhận & Render bản cuối"** → render chạy (`dub.ttsAlign → dub.render` nếu bật dubbing, thẳng `dub.render` nếu tắt). Thử không đăng nhập gọi API confirm → `401 AUTH_001` (BE-01).
2. **Banner quota:** dùng gần chạm RPD (hoặc hạ seed `provider_rate_limits` test) → banner vàng hiện mọi trang protected + stepper hiện "Đang chờ quota provider hồi phục lúc HH:mm" thay vì đỏ (BE-07/FE-03/FE-04).
3. **Round-robin đa key:** `Settings → API Keys` thêm 2 key cùng provider, đặt `priority` 0/1 → pipeline dùng key 0 trước; revoke/active toggle để xem failover (mức dùng per-key hiện ngay trên mỗi row, FE-05).

### 5.3. Chạy lại kiểm thử

```powershell
cd backend; npm test                                   # full regression (~130 files)
node tests/quotaRoundRobin.test.mjs                    # 9 asserts round-robin/failover
node tests/quotaPrecheck.test.mjs                      # 12 asserts quota warn + Retry-After
cd ..\frontend; npm run lint; npm run typecheck; npm run build
```

### 5.4. Việc tiếp theo đề xuất

1. Refresh `.team/TEST_REPORT.md` cho chu kỳ này (bản hiện tại là của chu kỳ docs-sync cũ).
2. Task lint-fix riêng cho 4 lỗi backend lint có sẵn.
3. Plan riêng cho BE-09 (BullMQ Flow `dub.merge`) khi Redis sẵn — kèm test barrier sống sót restart.
4. Cập nhật `Video_AI_docs/docs/10_TASKS.md` (PARTIAL → DONE từng mục), `06_API.md` (auth confirm-preview), `11` (bỏ nhãn PARTIAL đã xong), `04` (xóa dòng orphan).
