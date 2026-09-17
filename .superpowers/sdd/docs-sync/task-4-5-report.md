# Docs-sync task 4-5 report — 03+05+06 (branch main, no-commit)

## Status
- DONE — sửa ONLY 3 files docs, không sửa code, không commit.

## Files changed (docs only)
- `Video_AI_docs/docs/03_THIET_KE_BACKEND.md` (+41/-): TranslateDubPipeline → CURRENT sequential
  `[dub.ingest, dub.stt, dub.merge, dub.translate, dub.ttsAlign, dub.render]` + nhánh OR
  `ocrMode` + `dub.ocr` unreachable + dead-code/FFmpeg-serialize note; CancelProjectUseCase →
  `'cancelled'` (không `failed`); ví dụ `startTranslateDub` gắn [TARGET] + CURRENT note;
  §7 thêm CURRENT `sendError` contract + `RETRY_POLICY` + validation fail-fast.
- `Video_AI_docs/docs/05_THIET_KE_PIPELINE_CHI_TIET.md` (+51/-): §B.0 CURRENT stage list + OR/dead-code/
  FFmpeg note; §B.1 upload CURRENT (chunk 8MB cố định, ≤2GB; legacy 4GB) + xoá claim
  500MB/`MEDIA_MAX_UPLOAD_SIZE_MB`; §B.5 BLOCK_RENDER CURRENT + fail-fast + retry CURRENT;
  §E.4 CURRENT cancel `'cancelled'`; §E.1/E.2 gắn nhãn TARGET vs CURRENT.
- `Video_AI_docs/docs/06_API.md` (+229/-): header contract object/array trực tiếp + statuses
  lowercase + lỗi `{ message, code, error: { code, message } }`; cancel → `cancelled`;
  upload rows (8MB/2GB/OFFSET_MISMATCH/HEAD + legacy POST /upload/ EXTRA);
  SSE row (`?token=` + eventBus + `retry:3000` + heartbeat 15s); NOT IMPLEMENTED
  (mask-regions, media-stages ×2, media-consent ×2); EXTRA (PUT transcript, PATCH segment
  translation, POST redub, DELETE project, PUT api-keys, POST /upload/, forgot/reset-password,
  GET /auth/me); confirmPreview intended AUTH+OWNER note; full METHOD/PATH/AUTH bảng;
  ví dụ §7 object trực tiếp + lowercase; §8 MEDIA_00x → TARGET/NOT IMPLEMENTED, thêm
  RETRY_WAITING/OFFSET_MISMATCH/PIPELINE_RUNNING.

## Commits
- (no-commit) theo brief.

## Test summary (verification, không chạy suite — task docs-only)
- `git status --short -- backend/` → rỗng; `git diff --stat -- backend/` → rỗng: không file code nào đổi.
- `git diff --stat` 3 file docs: 03 (41), 05 (51), 06 (229) dòng đổi; + 2 file cũ 01+02 vẫn
  modified (từ task trước, OK).
- Grep `500MB|MEDIA_MAX_UPLOAD_SIZE_MB|{ data }` trong 3 file → chỉ còn 1 mention `{ data }`
  trong câu phủ định ("không bọc `{ data }`"); không còn claim 500MB/MEDIA env.
- `git status --short` tổng: chỉ 5 file docs modified (01, 02 cũ + 03, 05, 06 mới); untracked
  (`transflow/`, `background.mp4`, `.superpowers/`) là pre-existing, không chạm.

## Concerns
1. `confirmPreview.js` thiếu `authMiddleware` (chỉ `requireProjectOwner` đọc `req.user` → undefined
   nếu gọi trực tiếp): docs ghi intended AUTH+OWNER; cần task code riêng bổ sung auth.
2. `dub.ocr` unreachable nhưng `startDubSequential` vẫn reference: nếu sau này đưa `dub.ocr` vào
   `STAGES` thì FFmpeg serialize (`media/ffmpeg.js:126-136`) sẽ triệt tiêu lợi ích parallel —
   đúng như note đã ghi; FlowProducer vẫn là TARGET.
3. Mismatch nhỏ không thuộc scope (giữ surgical, chưa sửa): `dubData.js` comment nói "12 phong cách"
   trong khi 05/06 ghi "13 StylePreset".
