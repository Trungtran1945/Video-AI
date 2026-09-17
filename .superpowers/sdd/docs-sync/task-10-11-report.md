# Report task-10-11 — docs-sync cuối (10_TASKS + residuals)

Ngày: 2026-09-17. Branch: main. Không commit/push. Không sửa code/DB/docker/CI/deps.

## Status
- DONE. 5 file docs đổi: `10_TASKS.md` (relabel toàn bộ), `09` §1 (2 dòng) + §5 (1 dòng),
  `05` §D (1 dòng), `08` §6.1 (1 dòng note), `06` §2 confirm-preview (1 dòng note).
- `git diff --name-only -- backend frontend` → rỗng (không chạm code).
- Docs 00/01/02/03/04/05/06/07/08/09/11 đã sửa từ task trước — không rewrite, chỉ residuals trên.

## Truth đã chốt (file:dòng)
- Tempo: `backend/src/pipeline/forcedAlignService.js:14-15` → `TEMPO_MIN=0.80`, `TEMPO_MAX=1.20`.
  Docs sai `[0.9–1.15]` ở `05:372` (bảng quyết định) và `09:91` (ForcedAlignService test) → đã sửa
  thành `[0.8–1.2]`, cả hai trỏ về `forcedAlignService.js:14-15`. `05` §B.5 + `07:141` vốn đúng, giữ nguyên.
- `07:74` còn `[0.9, 1.1]` nhưng là clip-speed của SUMMARY AlignService (khái niệm khác atempo dub)
  → cố ý không chạm. `01:134`/`02:225` speed 0.9–1.1 cùng lý do.
- WPM: chỉ tồn tại ở `mockTts.js:15` (`wpm=150` ước lượng duration mock); docs không nhắc WPM → không có contradiction.
- confirm-preview orphan: BE `confirmPreview.js` + `confirmPreviewUseCase.js` + mount ở `routes/v1/index.js:23`
  tồn tại; FE chỉ có wrapper `frontend/src/api/projects.js:21`, `ProjectDetail.jsx` không gọi
  (grep `confirmPreview` FE = 1 match duy nhất) → [PARTIAL], khớp `04:126-128,354` đã ghi orphan.
- Presets: `seed.js` mảng `STYLE_PRESETS` đếm thực = 13 (`node -e` → PRESETS_COUNT=13) → 10 ghi "13 presets" [DONE] đúng.
- OCR: có dây end-to-end (`CreateProject.jsx:66` toggle → `projects.js:77` lưu → `runner.js:73` rẽ nhánh),
  nhưng exclusive ocr-HOẶC-stt + sequential → [PARTIAL], lý do ghi theo truth (không phải "unreachable" tuyệt đối).
- Round-robin: `selectBestApiKey` (`quotaGuardService.js:95`) tồn tại nhưng 0 caller;
  `registry.js:115-130` chỉ lấy key theo `priority` → auto-switch/rotation [PLANNED].
- Mask: `dubRender.js:196-258` chỉ định vị sub ASS theo vùng, không filter blur/fill/inpaint;
  route `mask-regions` không tồn tại → render-mask absent, SubRegionEditor absent (glob FE rỗng).
- NVENC: `mediaService.js:465-497` probe `h264_nvenc` + fallback CPU → partial đúng.
- QuotaGuard: snapshot/warning + `GET /quota` + `QuotaBar` ở `ApiKeys.jsx` có; banner toàn cục không có.
- Diarization: `dubStt.js:13` ghi rõ `speaker=NULL` ở v1 → `dub.stt` [PARTIAL].
- Cancel/overlap/upload/SSE/redub/transcript-edit/copyright/concurrency/cleanup: evidence khớp brief, [DONE].

## Lệch khỏi brief (source là truth)
1. Notification FR-J3 brief xếp NOT IMPLEMENTED — code CHỨNG MINH đã có:
   `notifyQueue.js` + `notifyWorker.js` (nodemailer, retry 2, skip graceful khi thiếu SMTP:17-20),
   runner enqueue khi done/fail (`runner.js:578,603`), cancel enqueue (`cancelProjectUseCase.js:62`).
   → 10 ghi [DONE]. Nếu brief muốn "push notification" (ngoài email) thì cần task mới làm rõ.
2. "Translate gates" brief xếp PARTIAL — không có dòng 10 nào tương ứng thiếu:
   `TRANSLATE_NEEDS_REVIEW` (`dubTranslate.js:240,341`, `runner.js:35`), `PATCH translation` gate
   (`projects.js:260-292`), semantic gate rút gọn (`dubTtsAlign.js:308`) đều có → dòng translate 10 ghi [DONE].
3. "OCR unreachable" — truth là reachable khi bật toggle (mặc định tắt) → giữ nhãn [PARTIAL] nhưng lý do theo code.
4. "QuotaGuard file-only" — Guard đọc DB (`provider_logs` + `provider_rate_limits`), không phải file;
   phần thiếu thật là banner toàn cục + auto round-robin → ghi đúng như vậy trong 10.
5. `seed.js:5,23` + `dubData.js:14` comment "12 phong cách" trong khi mảng có 13 phần tử — stale comment,
   ngoài scope residuals được liệt kê nên không sửa, ghi nhận ở đây.

## Test summary
- Không chạy test: change-set chỉ là markdown (`git diff --name-only -- backend frontend` rỗng),
  không có gì để break. Không suy diễn `[ ]`=missing khi thiếu proof — mọi nhãn đều có `file:dòng`.

## Concerns / đề xuất task sau
- `confirmPreview.js` thiếu `authMiddleware` (đã ghi trong 06) + FE chưa gọi — cần 1 task wiring + bổ sung auth.
- Làm rõ FR-J3 có bao gồm push (ngoài email SMTP) không.
- Stale "12 presets" trong 2 comment code (không sửa ở task này vì ngoài scope).
- `git status` còn modifications ở 00-04/07/11 từ các task trước (chưa commit) + untracked
  `.superpowers/`, `transflow/`, `Video_AI_docs/background.mp4` — ngoài scope, không động vào.
