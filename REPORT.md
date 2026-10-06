# BÁO CÁO TỔNG HỢP HOÀN CHỈNH — InitOnly (baseline khởi động đội ngũ)

**Ngày:** 2026-10-06 (UTC+07)
**Nhiệm vụ:** InitOnly — khởi tạo nền tảng đội ngũ (môi trường + baseline xanh + contract), chưa implement tính năng mới.
**Đầu vào đã đọc:** `.team/PLAN.md`, `.team/BACKEND_REPORT.md`, `.team/FRONTEND_REPORT.md`, `.team/TEST_REPORT.md` + `git status` / `git diff --stat` / `git log` trên nhánh `main`.
**Lưu ý trung thực (quan trọng):** 4 tài liệu nhóm KHÁC NHAU về độ tươi — `.team/PLAN.md` + `.team/BACKEND_REPORT.md` là **mới (chu kỳ InitOnly hôm nay)**; `.team/FRONTEND_REPORT.md` thuộc **chu kỳ trước** (TRANSLATE_DUB error-preservation, code đã commit trong `71a11bb`); `.team/TEST_REPORT.md` thuộc **2 chu kỳ trước** (2026-10-05, ZeroTTS/TTS-cache, suite 132 files). Turn này tôi **không chạy lại suite** — chỉ đọc reports + kiểm chứng git; mọi con số PASS đều ghi rõ nguồn. Không commit/push (đúng Git Rules).

---

## 1. Tóm tắt kết quả nhiệm vụ

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| **Kế hoạch** | Xong — `.team/PLAN.md` InitOnly mới (105 dòng). Giả định显式 A-01 (verify-only, không tính năng mới), thứ tự INIT-ENV → BE/FE-INIT → QA-INIT | `.team/PLAN.md` |
| **Backend** | Xong BE-INIT-01→08, **verify-only, 0 files changed**. Regression **134/134 PASS** (HEAD `71a11bb`); probes: FFmpeg PASS, DB HEALTHY, `/ready` ready, 13 style-presets; Redis BLOCKED (expected); lint FAIL 3 lỗi pre-existing (ngoài phạm vi) | `.team/BACKEND_REPORT.md` |
| **Frontend** | Không có report InitOnly mới; dùng lại kết quả chu kỳ trước: 4 files sửa (đã commit trong `71a11bb`), lint/typecheck/build PASS, contract khớp 100%, backend regression 134/134 PASS | `.team/FRONTEND_REPORT.md` (chu kỳ trước) |
| **Kiểm thử** | Không có QA pass mới chu kỳ InitOnly (QA-INIT-01→06 còn là checkbox chưa chạy). `TEST_REPORT.md` hiện tại **stale 2 chu kỳ** — không dùng làm evidence | §4 (đối chiếu rõ từng nguồn) |
| **Git** | Nhánh `main`, HEAD `71a11bb`, tree sạch (`git status` rỗng, `git diff --stat` rỗng). Không commit/push | `git status`, `git log` (§1.1) |

**Kết luận 1 dòng:** Baseline đã commit (`71a11bb`) được InitOnly-backend tái xác minh hôm nay là xanh (134/134 tests, API boot thật, DB HEALTHY); tồn đọng duy nhất là chạy nốt QA-INIT (frontend gates + contract + smoke trên cùng tree) và viết `TEST_REPORT.md` mới thay bản stale.

### 1.1. Trạng thái git thực tế (đã kiểm chứng lúc tổng hợp)

- Branch `main`, HEAD `71a11bb` ("cải thiện và sửa lỗi Dịch theo phong cách") — đã chứa toàn bộ fix TRANSLATE_DUB chu kỳ trước (runner, dubTtsAlign, generation, PipelineStatus, providerErrorMessage, CreateProject, ProjectDetail + REPORT.md).
- `git status --short`: rỗng. `git diff --stat`: rỗng. Modified/untracked/deleted do chu kỳ InitOnly: **0** (đúng tính chất verify-only).
- `.team/` bị gitignore (commit `0b93c88`) nên 4 docs team không hiện trong `git status` — bình thường.

---

## 2. Chi tiết các thay đổi Backend

> Nguồn: `.team/BACKEND_REPORT.md` (InitOnly, hôm nay) — **0 added / 0 modified / 0 deleted**, verify-only theo PLAN §1.4.

- **BE-INIT-01 — Toolchain: PASS.** Node `v24.14.1` (≥18 ✓), npm `11.11.0`, `npm ci` exit 0 (305 packages, 4s). Ghi nhận (không sửa): warnings deprecated + 11 vulnerabilities pre-existing → task riêng.
- **BE-INIT-02 — Env & secrets: PASS (1 BLOCKED con).** Chỉ đối chiếu tên key, không log giá trị: `GEMINI_API_KEY` present, `FFMPEG_PATH` present; `OPENAI_API_KEY` / `ELEVENLABS_API_KEY` / `DATABASE_URL` MISSING → flow provider live tương ứng BLOCKED. Không sửa `.env`.
- **BE-INIT-03 — Redis: BLOCKED (expected local).** `npm run check:redis` → `FAIL ECONNREFUSED 127.0.0.1:6379`; suite unit chạy được nhờ fallback in-process; queue live BLOCKED tới khi `docker compose up redis`.
- **BE-INIT-04 — FFmpeg: PASS.** `9.0.1-full_build-www.gyan.dev` (PLAN cũ 2026-09-17 ghi chưa cài — thực tế đã cài).
- **BE-INIT-05/06 — DB + API boot thật: PASS.** `node server.js` → `GET /health` 200 (`status=ok`, `database.persistenceState=HEALTHY`, `redis=disconnected`); `GET /ready` 200 `ready=True`; register user tạm → `GET /api/v1/style-presets` (Bearer) → **13 presets** (`co-trang,bat-trend,review-phim,tinh-cam,tai-lieu,hai-huoc,chinh-luan,gaming,kinh-di,the-thao,cong-nghe,tre-em,sat-nghia`). Server dừng sạch sau probe.
- **BE-INIT-07 — Regression: PASS.** `cd backend; npm test` → **ALL TEST FILES PASS — 134 files** (HEAD `71a11bb`); 1 SKIP có chủ ý `zeroTtsIntegration` (cần model 900MB).
- **BE-INIT-08 — Lint: FAIL (3 lỗi pre-existing, ngoài phạm vi — không sửa):** `transcriptTiming.js:222` (`GAP` unused), `glossaryService.js:5` (`queryOne` unused), `zeroTtsIntegration.test.mjs:79` (`AbortSignal` undef).
- Issues mở cho QA/Leader (không fix trong InitOnly): 3 lint trên + thiếu 2 keys + Redis down + `npm audit` 11 vulns → tasks riêng.

---

## 3. Chi tiết các thay đổi Frontend

> Nguồn: `.team/FRONTEND_REPORT.md` (**chu kỳ TRANSLATE_DUB trước**, code đã nằm trong HEAD `71a11bb`). Chu kỳ InitOnly không sửa file frontend nào (FE-INIT là verify — chưa có report chạy mới).

- **FE-E01 — `frontend/src/lib/providerErrorMessage.js`:** `friendlyJobError` map `TRANSLATE_NEEDS_REVIEW` (tỉ lệ + unresolved + hướng dẫn sửa Transcript), `BLOCK_RENDER:<CODE>` per-code (MISSING_TTS_AUDIO/SEMANTIC_BLOCK/UNTRANSLATED/MASK_*/OVERLAP/DUPLICATE_*/INVALID_*/TTS-duration), `ttsAlign incomplete`, `TRANSCRIPT/GENERATION_SNAPSHOT_MISSING`, `PROV_001/NO_PROVIDER_AVAILABLE` theo ngữ cảnh ASR/TTS/LLM; bỏ cắt cụt sớm khi chưa map.
- **FE-E02 — `frontend/src/components/project/PipelineStatus.jsx`:** truyền full `fJob` vào mapper; tooltip giữ full `error_message`; banner có `title` full message; nút retry đúng `failedStageKey`/`stageKey`; giữ giờ `next_retry_at` Việt Nam.
- **FE-E03/E04 — `frontend/src/pages/ProjectDetail.jsx`:** `qaByIndex` parse `unresolvedDetails` + legacy `details` + `ttsPartial` (`errors`/`missingSegments`); badge `[Lồng tiếng]/[Kiểm định]/[QA]` + nút seek; toast resume đọc `res?.fromStage`; guard `!isActive` chống double-run; `handleSaveTranscript` xử lý 422 + giữ conflict 409.
- **FE-E05 — `frontend/src/pages/CreateProject.jsx`:** guard `stylePreset` required; chuẩn hoá `audioMode` (`ORIGINAL_ONLY` khi tắt dubbing); error box hiện `[Trường <field>]`.
- **FE-E06 — Contract:** bảng đối chiếu `frontend/src/api/projects.js` ↔ `backend/src/routes/v1/` khớp 100% (20 endpoints); `client.js` single-flight refresh 401; SSE + polling 3s, DB là source of truth.
- Gates theo report: `lint` PASS (0 warnings/errors), `typecheck` PASS, `build` PASS (2201 modules, ~4.71s); error-mapping assertions PASS; backend regression 134/134 PASS. Giữ dark theme `#0F1117`, không SDK/BaaS mới.

---

## 4. Báo cáo kiểm thử & độ tin cậy

### 4.1. Ma trận theo nguồn (không gộp số liệu khác chu kỳ)

| Gate | Kết quả | Nguồn | Độ tươi |
|---|---|---|---|
| Backend `npm test` 134/134 PASS | **PASS** | BACKEND_REPORT (chạy hôm nay, HEAD `71a11bb`) + FRONTEND_REPORT §5 | Mới |
| Backend boot thật + `/health` HEALTHY + `/ready` + 13 presets | **PASS** | BACKEND_REPORT BE-INIT-05/06 | Mới |
| FFmpeg 9.0.1 / Redis BLOCKED expected | **PASS / BLOCKED** | BACKEND_REPORT BE-INIT-03/04 | Mới |
| Backend `lint` 3 lỗi pre-existing | **FAIL (ngoài phạm vi)** | BACKEND_REPORT BE-INIT-08 | Mới |
| Frontend `lint/typecheck/build` PASS | **PASS (theo report)** | FRONTEND_REPORT §4 (chu kỳ trước, cùng tree `71a11bb`) | 1 chu kỳ cũ, chưa chạy lại |
| Frontend contract 100% + mapping assertions | **PASS (theo report)** | FRONTEND_REPORT §3–§4 | 1 chu kỳ cũ, chưa chạy lại |
| ZeroTTS E2E `403 FORBIDDEN_PATH`, FE lint `Zap`, contract `zerotts/health` 404 | **FAIL (stale)** | TEST_REPORT 2026-10-05 (suite 132) | 2 chu kỳ cũ — **không dùng làm evidence** |

### 4.2. Vì sao `TEST_REPORT.md` không dùng được

- Ghi ngày 2026-10-05, đối chiếu PLAN chu kỳ TTS-Cache/ZeroTTS (suite **132** files — thiếu 2 files quota chu kỳ sau), git status trong đó liệt kê 14 files `M` (ZeroTTS/providerFailover/compose) **không còn tồn tại trên tree hiện tại** (đã commit xong từ `dc5d152`).
- Các FAIL trong đó (ZeroTTS E2E, lint `Zap`, mismatch `zerotts/health`) mô tả code đã bị thay thế bởi 2 commits sau (`a244b58`, `71a11bb`) → không kết luận được gì về HEAD hiện tại.

### 4.3. Tồn đọng & rủi ro

1. **QA-INIT-01→06 chưa chạy** (checkbox trong PLAN mới): cần 1 pass `backend npm test` + `frontend lint/typecheck/build` + contract + smoke `mock` trên cùng tree sạch, rồi viết `TEST_REPORT.md` mới.
2. Thiếu keys OpenAI/ElevenLabs + Redis down → flow live tương ứng BLOCKED (đã ghi nhận, không phải regression).
3. 3 lint backend pre-existing + `npm audit` 11 vulns → tasks riêng, không chặn baseline.

---

## 5. Hướng dẫn trải nghiệm / kiểm tra lại cho người dùng

### 5.1. Chạy local

```powershell
# Terminal 1 — backend trước
cd backend; npm run dev        # API http://localhost:3001 (/api/v1)
# Terminal 2 — frontend sau
cd frontend; npm run dev       # UI (Vite proxy /api + /storage → localhost:3001)
# Redis đầy đủ (tùy chọn)
cd backend; npm run check:redis
```

### 5.2. Kiểm tra baseline (khuyên dùng provider `mock` cho pipeline)

1. **Health:** `GET /health` → `status=ok` + `database.persistenceState`; `GET /ready` → 200 khi HEALTHY.
2. **Presets:** `GET /api/v1/style-presets` (Bearer) → 13 presets đủ `slug/name/description`.
3. **Wizard:** tạo project TRANSLATE_DUB (thiếu `stylePreset` → 400 `VALIDATION field=stylePreset`; đủ → 202 + pipeline chạy `dub.ingest→dub.stt`).
4. **Lỗi có hành động:** seed câu lỗi gate → `dub.translate` failed `TRANSLATE_NEEDS_REVIEW` → stepper tiếng Việt + Transcript highlight đúng segment → sửa tay → Regenerate resume từ `dub.translate`.
5. **Quota vs validation:** hết quota → message quota + provider đã thử; validation fail-fast 1 lần; rate-limit → stepper hiện giờ `next_retry_at` Việt Nam.

### 5.3. Chạy lại kiểm thử (lấp QA-INIT còn thiếu)

```powershell
cd backend; npm test                                  # full regression (kỳ vọng 134 files)
node tests/quarantine.test.mjs
node tests/renderBlock.test.mjs; node tests/renderValidation.test.mjs
node tests/resumeOrder.test.mjs; node tests/pipelineRetry.test.mjs
cd ..\frontend; npm run lint; npm run typecheck; npm run build
```

### 5.4. Việc tiếp theo đề xuất

1. Chạy QA-INIT-01→06 rồi **viết mới `.team/TEST_REPORT.md`** (bản hiện tại stale 2 chu kỳ).
2. Task lint-fix riêng cho 3 lỗi backend pre-existing.
3. Bổ sung keys OpenAI/ElevenLabs (tên key, không log giá trị) + `docker compose up redis` nếu cần flow live.
4. Khi có spec tính năng/lỗi cụ thể → mở plan mới (giữ plan InitOnly này làm baseline).
