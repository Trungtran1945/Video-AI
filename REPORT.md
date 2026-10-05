# BÁO CÁO TỔNG HỢP HOÀN CHỈNH — Khôi phục Dịch thuật & Lồng tiếng (TRANSLATE_DUB)

**Ngày:** 2026-10-06 (UTC+07)
**Nhiệm vụ gốc:** Bước Dịch thuật và lồng tiếng bị lỗi không thực hiện được, nghi liên quan phần trả về kết quả lỗi khi chạy backend. Khôi phục hệ thống hoạt động ổn định.
**Đầu vào đã đọc:** `.team/PLAN.md`, `.team/BACKEND_REPORT.md`, `.team/FRONTEND_REPORT.md`, `.team/TEST_REPORT.md` + `git status` / `git diff --stat` / `git log` trên nhánh `main`.
**Lưu ý trung thực (quan trọng):** `.team/TEST_REPORT.md` thuộc **chu kỳ cũ** (2026-10-05, scope TTS Cache Isolation + ZeroTTS Hardening + Failover: suite 132 files, ZeroTTS E2E `403 FORBIDDEN_PATH`, lint `Zap` unused, contract `zerotts/health` 404). Chu kỳ hiện tại (PLAN khôi phục TRANSLATE_DUB, HEAD `a244b58`) có kết quả kiểm thử mới nhất nằm trong `BACKEND_REPORT.md` (134 files PASS) + `FRONTEND_REPORT.md` (lint/typecheck/build PASS). Turn này tôi **không chạy lại suite** — chỉ đọc reports + kiểm chứng git; mọi con số PASS đều ghi rõ nguồn. Không commit/push (đúng Git Rules).

---

## 1. Tóm tắt kết quả nhiệm vụ

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| **Kế hoạch** | Xong — `.team/PLAN.md` (134 dòng). Chốt root-cause error-truncation + quarantine, thứ tự BE-E01→E11 / FE-E01→E06 / QA-DUB-01→08 + QA-REG | `.team/PLAN.md` |
| **Backend** | Xong BE-E01→E11 (3 files sửa, 0 thêm/0 xóa; phần VERIFIED giữ nguyên không chạm) | `.team/BACKEND_REPORT.md` + `git diff --stat` (khớp) |
| **Frontend** | Xong FE-E01→E06 (4 files sửa, 0 thêm/0 xóa; lint/typecheck/build PASS theo report) | `.team/FRONTEND_REPORT.md` + `git diff --stat` (khớp) |
| **Kiểm thử** | Mới nhất (từ team reports): backend **134 files PASS**, 7 targeted PASS; frontend 3 gates PASS. `TEST_REPORT.md` hiện tại **stale** — chưa có kết quả cho chu kỳ này | §4 (ghi rõ nguồn từng con số) |
| **Git** | Nhánh `main`, HEAD `a244b58`, 7 files `M`, 0 untracked mới do chu kỳ này. Không commit/push | `git status`, `git log` (§1.1) |

**Kết luận 1 dòng:** Lỗi “Dịch thuật & Lồng tiếng không chạy được” đã được khoanh vùng về lớp trả lỗi (truncate `error_message`, quarantine chỉ nằm ở `job.result`, frontend thiếu mapping `TRANSLATE_NEEDS_REVIEW`/`BLOCK_RENDER`) và đã hiện thực fix surgical trên working tree (giữ kiến trúc pipeline/provenance); tồn đọng xác thực: chạy lại full suite + QA-DUB end-to-end trên môi trường có Redis/provider keys live.

### 1.1. Trạng thái git thực tế (đã kiểm chứng lúc tổng hợp)

- Branch `main`, HEAD `a244b58 feat(quota,failover): quota-summary endpoint and aggregate Retry-After policy`.
- `git status --short` (7 modified, 0 untracked mới chu kỳ này):
  - `M backend/src/pipeline/runner.js`
  - `M backend/src/pipeline/stages/dubTtsAlign.js`
  - `M backend/src/routes/v1/generation.js`
  - `M frontend/src/components/project/PipelineStatus.jsx`
  - `M frontend/src/lib/providerErrorMessage.js`
  - `M frontend/src/pages/CreateProject.jsx`
  - `M frontend/src/pages/ProjectDetail.jsx`
- `git diff --stat`: **7 files, 296 insertions(+) / 58 deletions(−)**.
- Deleted: none. Không chạm: `.env`, `data.db`, `storage/*`, `schema.js`, enum status, STT/translation core, sql.js single-writer.
- Lưu ý: `.team/` bị gitignore (commit `0b93c88`) nên docs team không hiện trong `git status` — bình thường.

---

## 2. Chi tiết các thay đổi Backend

> Nguồn: `.team/BACKEND_REPORT.md` + `git status` / `git diff` (đã đối chiếu — khớp 3 files).

### 2.1. `backend/src/pipeline/runner.js` — BE-E01 (P0, error preservation)

- Thêm `truncateErrorMessage(msg, 500)` (export cho test): cắt ở **giữa**, giữ prefix mã (`TRANSLATE_NEEDS_REVIEW:` / `BLOCK_RENDER:` / `[PROVIDER_*]` / `PROV_001/002`) + suffix action (PATCH path + regenerate hint), nối bằng `\n…[truncated]…\n`. Message ngắn hơn 500 giữ nguyên.
- `failJob` + `logProviderCall` dùng hàm này thay cho `slice(0,500)` cũ (trước đây cắt đuôi → mất đoạn action cuối).
- `logStageFailure` log error tới 2000 ký tự (trước 300), giữ đủ category/provider/errorCode/cooldown để chẩn đoán.
- Không đổi: `describeFailure`, `isValidationError` (fail-fast đúng 2 tiền tố validation), `RETRY_POLICY`, resume clamp `firstRunnableStage`.

### 2.2. `backend/src/pipeline/stages/dubTtsAlign.js` — BE-E02 + BE-E11 (P0)

- Import `updateGenerationJobOwned`; khối `errorCount>0` persist `job.result` JSON `{ttsPartial, completedSegments, missingSegments, totalSegments, errorCode, errors[]}` best-effort (có `runToken` fencing) **trước khi throw** — trước đây chỉ throw message slice 5 lỗi × 120 chars + fields trên Error object (mất khi persist vì `failJob` không ghi `result`).
- Message tổng thêm `[firstErrorCode]` + hint `job.result.missingSegments` để frontend render danh sách segment thiếu mà không parse string.
- Giữ invariant `errorCount>0 → throw` (không success giả partial), partial files giữ (rerun chỉ synth thiếu), per-segment `{segmentId,indexNum,error,errorCode}`, `KEY_LEVEL_CODES` dừng batch, `RATE_LIMIT_STREAK_TO_STOP=3`.

### 2.3. `backend/src/routes/v1/generation.js` — BE-E06 (resume/redub contract)

- Redub thêm guard `429 RETRY_WAITING` khi `firstRunnableStage` báo waiting (đồng nhất retry/regenerate) + trả `fromStage: 'dub.ttsAlign'` trong response để FE toast đúng (giữ nguyên `runPipeline(..., 'dub.ttsAlign', ...)` và guard `translated>0` — tương thích test manualEdit/redubUsesManual).
- Resume clamp thực tế vẫn do `runPipelineOwned` enforce — route không gọi thẳng stage.

### 2.4. VERIFIED không đổi (đã rà soát, không sửa theo surgical)

- BE-E03 quarantine (`dubTranslate.js` mọi đường `TRANSLATE_NEEDS_REVIEW` đều `persistTranslateReview` trước throw; shape `{needsReview, unresolvedDetails[{segmentId,index,source,base,styled,baseErrors,styledErrors,qa}]}` đủ cho `qaByIndex`).
- BE-E04 tiền tố mã stage (`TRANSLATE_NEEDS_REVIEW` / `BLOCK_RENDER:<CODE>` / `TRANSCRIPT_SNAPSHOT_MISSING` / `GENERATION_SNAPSHOT_MISSING` / `PROV_001` / `NO_PROVIDER_AVAILABLE+completedChunks/totalChunks/errorCode`).
- BE-E05 `GET jobs` `SELECT j.*` trả đủ `type,status,error_message,result,next_retry_at,attempts,payload` (không cắt ở route).
- BE-E07 `PATCH segments/:id/translation` (hard→422 kèm `errors[]`, soft cho qua, conflict→409, DB blocked→503).
- BE-E08 `GET/PUT transcript` + `GET /:id` ẩn output cũ khi active + `outputStale`.
- BE-E09 `validateForRender` policy A + mask strict (`MASK_DATA_UNAVAILABLE`/`MASK_INVALID`).
- BE-E10 quota/auth/model fail-fast vs TRANSIENT park-retry; BE-E11 STT diagnostics.
- Contract `sendError {message, code, error:{code,message}}` giữ nguyên.

---

## 3. Chi tiết các thay đổi Frontend

> Nguồn: `.team/FRONTEND_REPORT.md` + `git diff --stat` (4 files — khớp).

- **FE-E01 — `frontend/src/lib/providerErrorMessage.js` (+101/−theo diff):** `friendlyJobError` mở rộng — `TRANSLATE_NEEDS_REVIEW` (bóc tỉ lệ `incomplete X/Y` + `unresolved` + hướng dẫn sửa Transcript rồi chạy lại từ `dub.translate`, kèm hint quá tải LLM); `BLOCK_RENDER:<CODE>` per-code (`MISSING_TTS_AUDIO` → thử lại `dub.ttsAlign`; `SEMANTIC_BLOCK/UNTRANSLATED` → sửa segment; `MASK_*` → tab Che chữ; `OVERLAP/TIMELINE_OVERLAP/DUPLICATE_SUBTITLE/INVALID_TIMING/INVALID_DURATION/DUPLICATE_AUDIO/INVALID_TTS_DURATION/MISSING_TTS_FILE` → sửa timing/text hoặc chạy lại TTS); `dub.ttsAlign incomplete` (tỉ lệ + thử lại TTS); `TRANSCRIPT_SNAPSHOT_MISSING/GENERATION_SNAPSHOT_MISSING`; `PROV_001/NO_PROVIDER_AVAILABLE` phân loại ASR/TTS/LLM → trang API Keys. Bỏ cắt cụt vô điều kiện khi chưa map (giữ đủ mã để debug); giữ các nhánh quota/auth cũ.
- **FE-E02 — `frontend/src/components/project/PipelineStatus.jsx`:** truyền full object `fJob` vào `friendlyJobError`; tooltip stage giữ full `error_message` (`\nChi tiết:` nguyên vẹn); banner lỗi có `title` full message; nút retry gọi đúng `failedStageKey`/`stageKey` (không hard-code); giữ hiển thị `next_retry_at` giờ Việt.
- **FE-E03/FE-E04 — `frontend/src/pages/ProjectDetail.jsx` (+140/−theo diff):** `qaByIndex` parse cả `unresolvedDetails` + legacy `details` (translate) và `ttsPartial` (`result.errors`/`missingSegments` của `dub.ttsAlign`), gắn cờ `[Lồng tiếng]/[Kiểm định]/[QA]` + `gate.errors` + nút seek; `handleRegenerate/handleRetryStage/handleRedub/handleConfirmPreview` đọc `res?.fromStage` để toast đúng bước (redub giữ note giữ bản dịch); thêm guard `!isActive` chống double-run (409); `handleSaveTranscript` xử lý 422 kèm `errors[]`, giữ conflict 409 (giữ local edits + refetch); tooltip `title={job.error_message}` ở panel TTS/jobs.
- **FE-E05 — `frontend/src/pages/CreateProject.jsx`:** guard `stylePreset` required ngay tại form (chặn request rỗng); chuẩn hoá `audioMode` (`ORIGINAL_ONLY` khi tắt dubbing, `DUB_MIX/DUB_REPLACE` khi bật, cả payload + `params`); error box hiện `[Trường <field>]` khi backend trả `field`.
- **FE-E06 — Contract:** đối chiếu `frontend/src/api/projects.js` ↔ `backend/src/routes/v1/` khớp 100% theo report (list/get/create/timeline/regenerate/remove/summaryStart/translateDubStart/jobs/retryJob/cancel/transcript/updateTranscript/updateSegmentTranslation/redub/masks/glossary/confirmPreview/sseTicket/stylePresets); `client.js` giữ single-flight refresh 401 retry 1 lần; SSE + polling 3s giữ DB là source of truth.
- Giữ dark theme `#0F1117`, không thêm SDK/BaaS, chỉ gọi REST qua `src/api/client.js`. Không đụng `components/timeline/` CapCut.

---

## 4. Báo cáo kiểm thử & độ tin cậy

### 4.1. Chu kỳ hiện tại (nguồn: BACKEND_REPORT + FRONTEND_REPORT, 2026-10-06)

| Gate | Kết quả (nguồn) | Ghi chú |
|---|---|---|
| Backend regression `cd backend; npm test` | **ALL TEST FILES PASS — 134 files** (132 cũ + 2 mới `quotaAccounting`, `quotaSummary`) — `BACKEND_REPORT §4` | Chạy bởi Backend agent; có 2 lần FAIL giữa chừng (`manualEdit`, `redubUsesManual`) đã revert/rút gọn và PASS lại |
| Targeted sau fix | **ALL PASS**: `quarantine`, `pipelineRetry`, `renderBlock`, `renderValidation`, `resumeOrder`, `redubUsesManual`, `manualEdit` | Liên quan trực tiếp scope BE-E01→E11 |
| Truncate sanity (`node -e` import runner) | **PASS**: message dài 700+ → len 500, giữ `TRANSLATE_NEEDS_REVIEW:` đầu + `PATCH` đuôi; message ngắn nguyên vẹn | BE-E01 |
| Env probes lúc làm backend | Node **v24.14.1**; Redis `check:redis` **FAIL** (ECONNREFUSED 127.0.0.1:6379, BLOCKED cho flow cần Redis live, suite vẫn chạy vì fallback); FFmpeg **9.0.1-full_build-www.gyan.dev PASS** (trái ghi chú “chưa cài” cũ trong AGENTS.md); `GET /health`/`GET /ready` **NOT_VERIFIED** (không server sống lúc làm) | `BACKEND_REPORT §1` |
| Frontend `npm run lint` | **PASS** (0 warnings/errors) — `FRONTEND_REPORT §1,§4` | `eslint . --quiet` |
| Frontend `npm run typecheck` | **PASS** (0 errors) | `tsc -p ./jsconfig.json` |
| Frontend `npm run build` | **PASS** (2201 modules, ~4.71s) | `vite build` |
| Error-mapping assertions | **PASS**: `TRANSLATE_NEEDS_REVIEW`, `BLOCK_RENDER` per-code, `PROV_001`, `ttsAlign incomplete`, unmapped giữ nguyên | Unit assertions trong FRONTEND_REPORT |
| Contract FE↔BE | **Không đổi** method/path/payload sau sửa API | Theo FRONTEND_REPORT bảng đối chiếu |

### 4.2. `TEST_REPORT.md` stale — đối chiếu để tránh lẫn số liệu

- File đó (2026-10-05) thuộc chu kỳ TTS-Cache/ZeroTTS: backend **132 files PASS**, 7 targeted PASS, nhưng có các FAIL **không thuộc chu kỳ này**: ZeroTTS E2E `403 FORBIDDEN_PATH: out_path outside OUTPUT_ROOT` (lệch `OUTPUT_ROOT` Windows/Docker), backend lint 3 errors pre-existing (`transcriptTiming.js:222`, `glossaryService.js:5`, `zeroTtsIntegration.test.mjs:79`), frontend lint 1 error (`PipelineStatus.jsx` import `Zap` unused — file này chu kỳ hiện tại đã sửa lại nên số dòng/cột cũ không còn giá trị), contract mismatch `GET /providers/zerotts/health` 404.
- Các FAIL trên **không được dùng làm evidence cho HEAD mới**; QA chu kỳ hiện tại phải chạy lại `QA-DUB-01→08 + QA-REG` trong `.team/PLAN.md §4.2` và refresh `TEST_REPORT.md`.
- Số lint “3 pre-existing” (BACKEND_REPORT) vs các số trong TEST_REPORT lệch nhau do khác thời điểm/scope đếm — thống nhất: lỗi có sẵn ngoài phạm vi, cần task lint-fix riêng.

### 4.3. Tồn đọng & rủi ro thực sự còn lại

1. **Chưa chạy lại full suite sau khi cả BE+FE cùng vào working tree** — BACKEND_REPORT chạy 134 PASS trước khi FE sửa; FRONTEND_REPORT chạy 3 gates riêng. Cần 1 lần `cd backend; npm test` + `cd frontend; npm run lint/typecheck/build` cuối cùng trên cùng tree (7 files M hiện tại).
2. **`GET jobs` vẫn `LEFT JOIN provider_logs ... status='ok'` có thể duplicate rows** khi 1 job có nhiều ok-logs (TTS batch) — frontend hiện dedupe nên không vỡ, nhưng payload thừa. Fix đúng (aggregate latest-log) vượt surgical, để đợt sau (theo BACKEND_REPORT).
3. **Redub `fromStage` route-level luôn `dub.ttsAlign`**, nhưng runner có thể clamp ngược về `dub.translate` khi translate còn failed — toast sẽ nói ttsAlign trong khi pipeline thực chạy từ translate (runner log `Clamped resume`). Muốn chính xác tuyệt đối phải poll `GET jobs` sau trigger (theo BACKEND_REPORT).
4. Redis DOWN + thiếu `/health` live + provider keys live → mọi path queue/cleanup/quota-live và QA-DUB end-to-end với provider thật ở trạng thái **NOT_VERIFIED/BLOCKED**, chỉ verified qua mock/unit.
5. Đổi shape `job.result` (`ttsPartial` mới) là breaking-change tiềm ẩn cho `qaByIndex`/`PipelineStatus` — BE đã giữ `[errorCode]` trong message để fallback, FE mới đã parse cả 2 shape; vẫn cần QA-DUB-04 xác nhận trên dữ liệu thật.

---

## 5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng

### 5.1. Chạy local

```powershell
# Terminal 1 — backend trước
cd backend; npm run dev        # API http://localhost:3001 (/api/v1)
# Terminal 2 — frontend sau
cd frontend; npm run dev       # UI (Vite proxy /api + /storage → localhost:3001)
# Queue đầy đủ (tùy chọn): kiểm tra Redis trước
cd backend; npm run check:redis
```

### 5.2. Trải nghiệm thay đổi mới (khuyên dùng video ngắn ≤10 phút, provider `mock` cho pipeline, key thật khi test STT/TTS/LLM)

1. **Tạo TRANSLATE_DUB:** wizard bắt buộc chọn `stylePreset` (13 preset từ `GET /style-presets`); tắt dubbing → `audioMode=ORIGINAL_ONLY`, bật → `DUB_MIX`/`DUB_REPLACE`. Thiếu preset/copyright → error box hiện rõ `[Trường <field>]`.
2. **Lỗi dịch có hành động:** seed câu lỗi gate → `dub.translate` failed `TRANSLATE_NEEDS_REVIEW`; stepper hiện tiếng Việt + số câu lỗi; tab Transcript highlight đúng segment (badge `[QA]/[Kiểm định]`, `baseErrors/styledErrors`); sửa tay → `PATCH` (bản còn lỗi → 422 kèm `errors[]`); Regenerate resume từ `dub.translate` (toast hiện đúng `fromStage`).
3. **Lỗi TTS partial:** mock TTS fail 1 segment → `dub.ttsAlign` failed, message giữ `[errorCode]` + `job.result.missingSegments`; panel TTS/Transcript gắn cờ câu thiếu audio; Retry đúng stage TTS (không hard-code render); redub giữ bản dịch đã sửa.
4. **Render block:** thiếu TTS audio → `BLOCK_RENDER: MISSING_TTS_AUDIO` với ids; mask malformed → `MASK_INVALID`; DB mask fail → `MASK_DATA_UNAVAILABLE`; tab Che chữ hiện lỗi tương ứng.
5. **Quota vs validation:** hết quota → message quota rõ + provider đã thử (không retry mù); validation fail-fast 1 lần (không park-`queued`); rate-limit → stepper hiện giờ hồi phục `next_retry_at` giờ Việt + nút thử lại sau.
6. **SSE + output:** kill SSE giữa pipeline → polling 3s vẫn cập nhật; terminal event reload (tối đa 3×800ms); khi `pending/queued/running` không hiện output cũ; sau sửa transcript/mask → banner `outputStale` “Nhấn Chạy lại”.

### 5.3. Chạy lại kiểm thử

```powershell
cd backend; npm test                                  # full regression (kỳ vọng 134 files)
node tests/quarantine.test.mjs
node tests/renderBlock.test.mjs; node tests/renderValidation.test.mjs
node tests/resumeOrder.test.mjs; node tests/pipelineRetry.test.mjs
node tests/redubUsesManual.test.mjs; node tests/manualEdit.test.mjs
node tests/dubTranslate.batch.test.mjs; node tests/dubTranslate.backfill.test.mjs
cd ..\frontend; npm run lint; npm run typecheck; npm run build
```

### 5.4. Việc tiếp theo đề xuất

1. Chạy 1 pass cuối `npm test` + `lint/typecheck/build` trên cùng tree 7 files M rồi refresh `.team/TEST_REPORT.md` cho chu kỳ này (bản hiện tại là chu kỳ cũ) + chạy `QA-DUB-01→08`.
2. Quyết định fix đợt sau: dedupe `GET jobs` join (latest-log), toast redub khớp clamp tuyệt đối (poll `GET jobs` sau trigger).
3. Task lint-fix riêng cho các lỗi pre-existing ngoài phạm vi.
4. Future work: bytes-based shared computation cache nếu còn hiện tượng last-writer-wins (ngoài phạm vi đợt này).
