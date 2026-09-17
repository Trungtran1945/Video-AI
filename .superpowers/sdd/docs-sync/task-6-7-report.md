# Docs-sync task 11+07 — Report

- Scope: `Video_AI_docs/docs/11_RATE_LIMIT_VA_FREE_TIER.md`, `Video_AI_docs/docs/07_MODULE_FFMPEG.md` (branch `main`).
- Pattern: `# Current Implementation (CURRENT)` + nhãn inline `CURRENT/PARTIAL/NOT IMPLEMENTED/TARGET/FUTURE` theo các task 01/02/03/05/06. Tiếng Việt, surgical (chỉ thêm header + dòng `> [...]`, không viết lại body).

## File 11 — RATE_LIMIT
- CURRENT: TokenBucket+SlidingWindow+daily per `(userId,provider,apiKeyId)` (`lib/rateLimiter.js`); Gemini per-key window (`providers/rateLimit.js`) + `Retry-After`/`retry in Xs` backoff (`geminiClient.js:106-116`); cache SHA-256 + TTL 90d (`lib/callProvider.js`); fallback segment (OCR→tesseract `registry.js:160-164`, EdgeTTS→Google `edgeTts.js:42-50`, GT→LLM restyle `dubTranslate.js:153-212`, loudnorm→raw `dubIngest.js:34-38`, NVENC→x264 `mediaService.js:491-503`); 429 park `now+60s` (`runner.js:38-45`), MAX 5 (`runner.js:408-414`), project `queued` (`runner.js:277-280`).
- PARTIAL: `callProvider` hardcode `rpm:10` (`callProvider.js:139-143`), bỏ qua DB + `safetyMargin`; cache bỏ qua `providerCacheEnabled/TTL` (`config.js:46-47`); `quotaGuardService.js` (q thường) chỉ wired `GET /providers/:provider/quota` (`routes/v1/providers.js:83-91`), không pre-check/injection `quota_risk`.
- NOT IMPLEMENTED: round-robin/cooldown đa key (`registry.js:115-131` single-key); `selectBestApiKey` dead code + per-key ineffective (`quotaGuardService.js:109-122`).

## File 07 — FFMPEG
- CURRENT: `resolveBin` (`ffmpeg.js:13-52`); `enqueue()` serialize (Win exit -22) (`ffmpeg.js:123-136`); NVENC p4/cq23 else x264 veryfast/crf20 chỉ `burnSubtitlesStyled`, còn lại hardcode x264, `muxStream -c:v copy` (`mediaService.js:366-503`); timeout stage 15/30m (`runner.js:321-327`) + BURN 20m + DUB_TRACK 15m (`dubRender.js:20-21`) + SIGTERM→SIGKILL 5s (`ffmpeg.js:54-91`); ASS pos từ ratios original/top/bottom/custom (`dubRender.js:199-279`).
- NOT IMPLEMENTED: `maskRegions()` blur/fill/delogo/inpaint + `maskStrength`/`between(t)` (grep `backend/src/media` rỗng; DB đã có cột nhưng chưa consumer `schema.js:286-300`); inpaint FFmpeg-native (cần external provider).
- PARTIAL: `signal` mọi media fn + `CANCELLED_BY_USER` + cleanup partial — chỉ abort biên stage (`throw 'Cancelled'`), `runBin` có signal nhưng `mediaService.js` không nhận.

## Status / Commits / Tests
- Status: DONE (không commit theo GLOBAL).
- Commits: no-commit (làm bẩn thêm đúng 2 file docs trên working tree đã có sẵn 01/02/03/05/06 từ task trước).
- Verify: đã đọc lại 2 file; `git status --short` hiện `M 07` + `M 11` (+ các `M 01/02/03/05/06` cũ); `git diff --stat` gồm 7 files docs; `git diff --name-only -- backend` rỗng (không sửa code).
- Nhãn: grep 2 file chỉ còn `CURRENT/PARTIAL/NOT IMPLEMENTED/TARGET/FUTURE`, không `EXTRA/TODO`.

## Concerns
- `getNextRetryAt` có query `provider_rate_limits` nhưng không dùng kết quả (luôn `now+60s`) — docs ghi CURRENT đúng hành vi này, không claim đọc RPM thật.
- `selectBestApiKey` là dead code nhưng vẫn export — docs ghi rõ để tránh tái wired nhầm thành `QuotaGuardService` hoa.
- `ocr_regions.mask_strength/is_static` tồn tại trong schema nhưng chưa consumer — nguy cơ hiểu nhầm mask đã chạy; docs đã chặn bằng NOT IMPLEMENTED.
