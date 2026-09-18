# TASK-044

## Title
Include edge_tts, OCR, and translate providers in providers status route

## Type
refactor

## Priority
medium

## Autonomy
auto

## Evidence
[`providers.js:46-75`](file:///D:/E/Video_AI/backend/src/routes/v1/providers.js#L46-L75): In `GET /api/v1/providers`, the `tts` provider list explicitly registers `elevenlabs`, `google_tts`, `azure_speech`, and `openai_tts`, but omits `edge_tts` (which is the default voice provider in `schema.js` and `settings.js`). Additionally, `GET /api/v1/providers` does not return `ocr` (`gemini`, `tesseract`) or `translate` (`google_translate`) provider sections, preventing frontend settings and health dashboards from inspecting their availability and health.

## Affected Areas
- `backend/src/routes/v1/providers.js`

## Expected Outcome
Add `decorate('edge_tts')` to the `tts` array, and add `ocr: [decorate('gemini'), decorate('tesseract')]` and `translate: [decorate('google_translate')]` to the returned payload.

## Constraints
Maintain backward-compatible schema structure for existing frontend consumers.

## Suggested Verification
`cd backend && node -e "import('./src/routes/v1/providers.js')"`

## Status
PENDING
