# Changes

## Files Changed
- backend/src/pipeline/stages/dubMerge.js — thêm `findDuplicateGroups` + `dedupeTranscriptSegments` (auto-merge STT lặp nguyên văn trong DB) và gọi best-effort trong stage `dub.merge`
- backend/src/pipeline/runner.js — auto-dedupe best-effort trước `validateForRender` ở nhánh `dub.render` + message riêng cho `DUPLICATE_SUBTITLE`
- backend/src/providers/tts/edgeTts.js — `EDGE_TTS_CHROMIUM_VERSION` env-overridable + diagnostics (close code/reason, server text) + `turn.end` không audio thành lỗi rõ
- backend/tests/dedupeDuplicates.test.mjs — test mới cho dedupe (pure + DB + validate + idempotent)

## Changes Made
1. `dubMerge.js`: `normalizeDupText` (trim chính xác, khớp hệt điều kiện validator — phân biệt hoa/thường và dấu câu, chỉ gộp lặp nguyên văn, không gộp paraphrase). `findDuplicateGroups(sorted)` trả về các nhóm liên tiếp có text trim bằng nhau và `|start - prev_end| < 1.0s`. `dedupeTranscriptSegments(projectId)` load segments theo `start_sec`, với mỗi nhóm keeper = bản đầu (giữ `start_sec` + translation), nới `end_sec` tới end xa nhất, copy translation donor đầu tiên khi keeper trống, `DELETE` các bản trùng, giữ nguyên `index_num` (không đánh lại số), idempotent, log số nhóm/bản đã gộp. Stage `dub.merge` gọi dedupe best-effort (try/catch, không throw) sau check language config và trả thêm `deduped` trong result.
2. `runner.js`: import `dedupeTranscriptSegments`; trong `executeStage` nhánh `dub.render`, chạy dedupe best-effort trước `validateForRender` để gỡ BLOCK cho project đang kẹt (vì `dub.merge` của chúng đã success nên Regenerate từ `dub.render` không chạy lại stage đó). Khi validation vẫn fail và errors chứa `DUPLICATE_SUBTITLE`, message `BLOCK_RENDER` được thêm đoạn hướng dẫn transcript (đã tự gộp lặp nguyên văn; câu còn lại khác dấu câu/chữ thì kiểm tra transcript, sửa timing/text rồi Regenerate). Các lỗi khác giữ message cũ (tương thích test quarantine kiểm tra substring PATCH).
3. `edgeTts.js`: `CHROMIUM_FULL_VERSION` đọc từ `process.env.EDGE_TTS_CHROMIUM_VERSION` (fallback giữ nguyên `143.0.3650.75`, không đổi hành vi mặc định). `synthesizeOnce` giữ `lastServerText` (message text cuối <2000 ký tự, cắt 200 khi báo lỗi, không chứa secret), `close` ghi `code` + `reason` vào error, `turn.end` mà chưa có byte audio nào giờ là lỗi rõ (`kết thúc lượt mà không có audio`) thay vì resolve buffer rỗng. Fallback Google TTS giữ nguyên.
4. Không đụng: Google Translate endpoint, Gemini retry, semantic gate, style preset (đang hoạt động đúng — xem Remaining Concerns).

## Reason
- Root cause fail duy nhất là `BLOCK_RENDER: 11 subtitle trùng lặp liên tiếp` từ `validateForRender` (soi `s.text` gốc của STT, không phải translation nên PATCH translation không gỡ được). STT hallucination lặp câu ngắn (`It's not a thing.` ×5, `How much?` ×3…). Theo lựa chọn của user: auto-gộp thay vì sửa tay/xóa hay hạ validator.
- Google 404 (2 segment rời rạc) đã được LLM-direct cứu, pipeline vẫn tới render → không phải blocker, không sửa code, chỉ hướng dẫn redeploy.
- Gemini 503 transient đã retry thành công → không sửa.
- Edge TTS đứt 18/18 rớt về gTTS → giữ Edge theo lựa chọn của user, fix ở mức chẩn đoán + version overridable (không đoán version mới khi chưa có bằng chứng mạng).

## Commands Executed
- `node tests/dedupeDuplicates.test.mjs` (workdir backend) — exit 0 sau lần sửa data lần 2 (lần 1 fail 1 case do data mẫu `Câu A` dính gate `length implausible`, đã thay bằng bản dịch thực tế) — ALL PASS (15 asserts)
- `npm test` (workdir backend, `node scripts/run-tests.mjs`) — exit 0 — ALL TEST FILES PASS (37 files, gồm file mới)
- `git status --short` + `git diff --stat` — chỉ đọc, không commit — 3 files sửa + 1 test mới; untracked có sẵn `Video_AI_docs/background.mp4`, `transflow/` (không phải của run này, để nguyên)

## Potential Risks
- Dedupe ở thời điểm render (sau `dub.ttsAlign`): audio của segment bị xoá thành orphan (không tham chiếu, không BLOCK), keeper nới `end` nên slot chỉ rộng ra — audio TTS cũ vẫn khớp duration. Trường hợp hiếm keeper trống translation và copy donor: keeper có thể thiếu `tts_audio_id` → `MISSING_TTS_AUDIO` BLOCK với message rõ → user chạy redub từ `dub.ttsAlign` là xong.
- Gộp chính xác trim-only: các câu gần-giống khác dấu câu (`Cold water bottle.` vs `...?`) không gộp và vẫn BLOCK nếu đủ điều kiện validator — đúng chủ ý (tránh gộp lố), message mới đã hướng dẫn case này.
- Edge TTS: chưa có bằng chứng mạng nên chưa bump version mặc định; nếu handshake vẫn bị từ chối, log giờ có `code/reason/server` để lần sau chẩn đoán trúng.

## Remaining Concerns
- **Cần user làm (không code tự làm được) — Google Translate 404:** mở Apps Script cũ → `Deploy > Manage deployments` (deployment cũ đã bị xóa) → `Deploy > New deployment > Web app` (`Execute as: Me`, `Access: Anyone`) → copy URL `.../exec` mới → cập nhật `backend/.env: GOOGLE_TRANSLATE_SCRIPT_URL=<url-mới>` (không log secret) → verify `curl "<url>?text=hello&target=vi"` expect `{"status":"success"}` → Regenerate project từ `dub.translate`. LLM-direct hiện tại đủ unblock project này; URL mới chống lỗi project sau.
- **Không hết token, không cần thay API trả phí** (Gemini/OpenAI/ElevenLabs key vẫn dùng được; 503 vừa rồi là transient đã tự hồi).
- **Để unblock project `8fe8c7fc…`:** bấm Regenerate/Retry (resume từ `dub.render` theo `firstRunnableStage`) — dedupe sẽ tự chạy trước validate. Nếu keeper nào bị copy translation donor mà thiếu TTS thì chạy thêm redub từ `dub.ttsAlign`.
- **Edge nếu vẫn lỗi sau deploy:** đặt `EDGE_TTS_CHROMIUM_VERSION=<bản Edge mới>` theo log `code/reason/server` mới rồi thử synth 1 câu vi ngắn cô lập trước khi chạy pipeline.

## Final Status
IMPLEMENTED
