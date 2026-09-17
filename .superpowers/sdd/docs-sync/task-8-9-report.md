# Report — docs-sync task 8+9 (files 04 + 00 + 08 + 09)

- Branch: `main` (không commit, không push — theo brief).
- Phạm vi: chỉ 4 files docs, không chạm code/DB/docker/CI/deps, không chạm 01/02/03/05/06/07/11.

## Status

- [x] `Video_AI_docs/docs/04_THIET_KE_FRONTEND.md` — đồng bộ CURRENT theo code.
- [x] `Video_AI_docs/docs/00_TAM_NHIN_VA_YEU_CAU.md` — unify 500MB → 2GB (2 chỗ, §2.1).
- [x] `Video_AI_docs/docs/08_TRIEN_KHAI_VA_VAN_HANH.md` — CURRENT npm ci / Node 22 / CI không test / docker build-only / compose SQLite.
- [x] `Video_AI_docs/docs/09_DONG_GOP.md` — CURRENT npm scripts + node:test, cấm pnpm -r/Vitest/Jest, cancel → `cancelled`.

## Thay đổi chính (04)

- §1 + §3: RHF+Zod → [TARGET/FUTURE]; CURRENT wizard local state; thêm note React `^18.2.0` JS,
  `tsc -p ./jsconfig.json`, liệt kê routes public/protected theo `App.jsx:58-78`.
- §4: SUMMARY 6 bước / DUB 5 bước + payloads theo `api/projects.js`; không `maskMethod`/`voiceId`/
  `maskStrength`; `subPosition='original'` + toggle `ocrMode` + `FreeTierWarning` + checkbox bản quyền.
  Bước "Nâng cao" và "Xem trước & Xác nhận" (FR-J2) → [NOT IMPLEMENTED]; `confirmPreview` là API
  orphan (FE wrapper `api/projects.js:21` có, `ProjectDetail` không gọi).
- §4.1 SubRegionEditor → [NOT IMPLEMENTED] (không Canvas/mask trong code).
- §4.2: `useJobEvents` + fallback polling 3s (chỉ khi SSE unavailable); stages CURRENT (không `dub.ocr`);
  cancel (`running`/`queued`/`pending` → `cancelled`); redub; banner `outputStale`.
- §5.1: layout CURRENT = transcript trái 58% + video phải 42% + VideoTimeline (bỏ SubRegionEditor/mask).
- §5.2: tracks [video, original, translated]; store actions CURRENT (không split/addTrack/lock-mute/
  snapEdges); `clip-video-main` + 2 lớp transcript read-only; drag `application/x-transcript-segment`
  là [PARTIAL] (có drag source, chưa có drop target); FloatingToolbar chỉ hiển thị; keyboard
  Space + arrows; `timeline-height` clamp 120–400.
- §5.3: transcript editor CURRENT (textarea dịch, lưu diff, redub, seek, speaker, chọn ngôn ngữ đích);
  timing inputs/CPS/overlap → [NOT IMPLEMENTED].
- §7/§8: `z.infer`/schema share → [TARGET/FUTURE]; hàng "Xem trước & Xác nhận" → [NOT IMPLEMENTED].

## Thay đổi chính (08 / 09 / 00)

- 08 §1/§2: Dockerfile CURRENT (api: Node 22 + ffmpeg + `npm ci` + `node server.js`; web: Vite → nginx);
  compose CURRENT redis:7 + api + worker (chung image api, profile `scale`) + web, SQLite file;
  Postgres/S3/worker-per-stage/`docker/worker.Dockerfile` → [TARGET/FUTURE].
- 08 §3: env CURRENT (`DATABASE_URL=file:./data.db`, `REDIS_HOST/PORT`, `JWT_ACCESS/REFRESH_SECRET`,
  3 provider keys); S3/ANTHROPIC/HF/YouTube → [TARGET/FUTURE].
- 08 §4: CI CURRENT — Node 22, `npm ci`, lint + typecheck + build, KHÔNG `npm test`;
  docker build-only `push: false`, tags `asf-api:latest` / `asf-web:latest`.
- 08 §5/§7: worker-per-stage/S3/Postgres → [TARGET/FUTURE]; CI row = lint+typecheck+build.
- 09 §2/§3: bảng CURRENT (ESLint FE, `tsc -p jsconfig.json`, `node:test`); backend
  `test = node scripts/run-tests.mjs` (~36 file), frontend không script `test`; quy trình đóng góp
  dùng `npm` (cấm `pnpm -r`/Vitest/Jest).
- 09 §5: `Project.status = cancelled` (không `failed`).
- 00: không có claim "cancel → FAILED" (FR-J1 đã ghi `CANCELLED` đúng); FR-J5 `FAILED` là trạng thái
  lỗi TTS, giữ nguyên theo brief (chỉ unify 2GB).

## Test summary

- Không sửa code nên không chạy test. Verify bằng đọc code + grep:
  - `git diff --name-only -- backend frontend` → rỗng (không chạm code).
  - `git diff --stat` → chỉ 4 files của task có thay đổi do tôi tạo (các file
    01/02/03/05/06/07/11 cũng dirty nhưng là thay đổi có sẵn của các task song song, tôi không chạm).
  - Grep hậu kiểm: mọi `maskMethod`/`voiceId`/`maskStrength` còn lại trong 04 đều nằm trong ngữ cảnh
    [NOT IMPLEMENTED]/[TARGET]; 08 không còn claim pnpm/test/push; 09 không còn pnpm/Vitest/Jest.

## Concerns

1. Working tree `main` đang dirty nhiều file docs cùng lúc (01/02/03/05/06/07/11 của task khác) —
   khi merge/squash cần đối chiếu để không đè lẫn nhau (đặc biệt 06 còn ghi confirm-preview là
   [CURRENT] trong khi 04 ghi orphan — cần task 06 xác nhận phía backend).
2. 09 §1 vẫn ghi "TypeScript strict ở mọi package" và §5 còn "supertest" — sai so với code JS hiện tại
   nhưng ngoài scope brief (chỉ scripts) nên để lại; đề xuất task sau gắn nhãn TARGET.
3. 08 §6 còn status UPPERCASE (`SUCCESS`/`FAILED`/`CANCELLED`) trong ngữ cảnh cleanup/notify design —
   code dùng lowercase; ngoài scope brief nên giữ nguyên, đề xuất unify ở task sau.
4. `DEFAULT_PROVIDER_MODE=mock` cho CI (08 §7, 09 §5) là có thật trong code (`backend/src/config.js:48`)
   nên giữ lại — nhưng CI hiện tại không chạy test nên giá trị thực tế chưa được dùng.
