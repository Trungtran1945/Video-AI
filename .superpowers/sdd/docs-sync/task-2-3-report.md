# Report — docs-sync task 2+3 (01 + 02) — implementer, branch main, no-commit

## Phạm vi
- Sửa ONLY 2 files: `Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md`, `Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md`.
- KHÔNG sửa code/backend/frontend/docker/CI. KHÔNG commit/push.
- Source truth đã đọc toàn bộ: `backend/src/db/schema.js` (382 dòng), `backend/src/db.js`,
  `backend/src/db/seed.js` (13 presets), `backend/src/pipeline/runner.js:111-154`
  (STAGES SUMMARY 8 / TRANSLATE_DUB 6), `backend/src/queue/*.js`
  (3 queues duy nhất: `projects`, `notifications`, `cleanup`; không FlowProducer,
  không per-stage queue), `.superpowers/sdd/docs-sync/progress.md`.
- Đối chiếu thêm bằng grep: `completed` lowercase dùng trong `runner.js:567`,
  `cancelProjectUseCase.js`, `routes/v1/analytics.js`, `routes/v1/projects.js`;
  không `MediaJobStage`/`MediaConsent`/`ttsAudioRef`/`maskMethod` nào trong `backend/src`;
  không `S3`/`StorageProvider` nào trong `backend/src`.

## File 01 — 01_KIEN_TRUC_TONG_THE.md (dòng theo file sau sửa, tổng 403 dòng)
1. Dòng 3–8: thêm `# Current Implementation (CURRENT)` + 4 bullets verbatim
   (layout phẳng JS ESM; sql.js/SQLite data.db + schema.js; runner sequential
   SUMMARY 8 / TRANSLATE_DUB 6 stages + stage list verbatim, không BullMQ per-stage;
   BullMQ+Redis chỉ projectQueue/notifyQueue/cleanupQueue).
2. Dòng 10–12: thêm `# Target Architecture (FUTURE — NOT IMPLEMENTED)` + note
   "giữ nguyên, không xóa" — mọi mô tả monorepo/TS/Prisma/BullMQ-per-stage cũ
   nằm dưới heading này.
3. Dòng 23: `## 1. Cấu trúc Monorepo` += `[TARGET/FUTURE]` (giữ nguyên text + tree).
4. Dòng 55: `## 2. Tầng kiến trúc` += `[TARGET/FUTURE]`.
5. §4 (dòng ~117): heading += `[TARGET/FUTURE]` + note: interface TS là tương lai;
   CURRENT là provider JS `backend/src/providers/`.
6. §5 (dòng ~160): heading += `[TARGET/FUTURE]` + note: job per-stage/worker song song
   là tương lai; CURRENT sequential + 3 queue `projects`/`notifications`/`cleanup`.
   Bảng job per-stage giữ nguyên (future).
7. §5.1 += `[TARGET/FUTURE]` (BullMQ Flow Producer). §5.2 += `[PARTIAL]`
   (cancel/notify tồn tại một phần: `cancelProjectUseCase.js` + `notifyQueue projectDone`).
8. §6.1 += `[PARTIAL]` + note: luồng stage khớp STAGES runner, riêng FlowProducer là TARGET.
9. §7 += `[TARGET/FUTURE]` + note: `packages/storage`+S3 là tương lai; CURRENT local
   qua `backend/src/pipeline/context.js` (`projectDir`/`resolveStorageKey`).
10. §8.4 (dòng ~353): heading += `[TARGET/FUTURE]` + 2 blockquote:
    STALE/SKIPPED/CANCEL_REQUESTED + MediaJobStage là TARGET/NOT IMPLEMENTED;
    CURRENT statuses lowercase pending/queued/running/completed/failed/cancelled
    (+ ref runner.js, cancelProjectUseCase.js). Prefix `[TARGET/FUTURE]` vào 3 dòng
    bảng STALE/SKIPPED/CANCEL_REQUESTED; giữ CANCELLED + quy tắc STALE nguyên văn.
11. Bảng §8 quyết định: prefix `[TARGET/FUTURE]` cho 2 dòng (Monorepo pnpm,
    BullMQ Flow Producer); `[NOT IMPLEMENTED]` cho dòng Media Consent versioned.
12. Không xóa design tương lai; giữ tiếng Việt + style.

## File 02 — 02_THIET_KE_CO_SO_DU_LIEU.md (tổng ~467 dòng)
1. Dòng 3–16: thêm `# Current Implementation (CURRENT)`:
   - 21 tables verbatim đúng thứ tự brief (users … upload_sessions).
   - Không FK constraints (manual cleanup); lowercase enums;
     projects.status='completed' ngoài enum cũ; settings ~15 cột
     (voice_provider='edge_tts', default_style='cinematic', không maskMethod);
     transcript_segments thiếu ttsAudioRef/startMs/endMs + wpm_warning TEXT;
     extras reset_tokens + upload_sessions;
     Prisma MediaConsent/MediaJob/MediaJobStage NOT IMPLEMENTED
     (không table trong schema.js), equivalents generation_jobs(type,step) +
     transcript_segments/ocr_regions;
     mapping snake↔camel 4 cặp verbatim.
2. Lưu ý block đầu: `mirror 1-1` → `mirror [PARTIAL]` + liệt kê lệch.
3. §1 sơ đồ: thêm note `[NOT IMPLEMENTED]` cho MediaConsent/MediaJob/MediaJobStage.
4. §2 heading += `[TARGET/FUTURE]` + blockquote liệt kê lệch Settings/TranscriptSegment/
   3 models. `model TranscriptSegment` giữ mô tả gốc + suffix `[PARTIAL] …`.
   Header `MEDIA PIPELINE ENTITIES` + 3 models += `[NOT IMPLEMENTED]` + equivalents.
5. §4 heading += `[TARGET/FUTURE]` + note CURRENT initSchema/seed.js.
6. §5: prefix `[NOT IMPLEMENTED]` (2 dòng MediaConsent/MediaJob+Stage),
   `[TARGET/FUTURE]` (3 dòng STALE/ttsAudioRef/startMs-endMs).
7. §6 heading += `(CURRENT)`; body `mirror 1-1` → `mirror [PARTIAL]`.
8. Nhãn chỉ dùng 1 trong 4: CURRENT / PARTIAL / NOT IMPLEMENTED / TARGET/FUTURE.

## Verification (output thật)
```
$ git status --short
 M Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md
 M Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md
?? .superpowers/sdd/docs-sync/      (có sẵn trước task; report này ghi vào đây theo brief)
?? Video_AI_docs/background.mp4     (có sẵn, không động vào)
?? transflow/                       (có sẵn, không động vào)

$ git diff --stat
 Video_AI_docs/docs/01_KIEN_TRUC_TONG_THE.md     | 56 ++++++++++++++++++-------
 Video_AI_docs/docs/02_THIET_KE_CO_SO_DU_LIEU.md | 50 +++++++++++++++-------
 2 files changed, 77 insertions(+), 31 deletions(-)
```
- Chỉ 2 file docs đổi (77 insertions, 31 deletions — toàn bộ là thêm heading/label/note,
  không xóa design tương lai ngoài việc thay 2 từ `mirror 1-1`).
- Đã đọc lại cả 2 file sau sửa (đầu file + diff đầy đủ) — nội dung khớp brief.
- Không commit (đúng constraint).

## Concerns
- `dub.ocr` tồn tại trong `STAGE_IMPL` (runner.js) nhưng KHÔNG nằm trong `STAGES.TRANSLATE_DUB`
  (6 stages verbatim theo brief); docs ghi đúng 6 stages — task sau (03+05) nên quyết định
  cách ghi `dub.ocr` điều kiện (`params.ocrMode`) để khỏi drift.
- §5.2 và §6.1 gắn `[PARTIAL]` là phán đoán của implementer (cancel/notify tồn tại một phần);
  sweep task 9 có thể chuẩn hóa lại khi có 06 (API contract) làm canonical.
- Untracked `transflow/`, `Video_AI_docs/background.mp4` có sẵn từ trước, không liên quan task.
