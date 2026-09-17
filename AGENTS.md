# Project Guidelines

## Andrej Karpathy Guidelines for AI Coding
Follow these 4 core principles on all coding tasks:

### 1. Think Before Coding
- Don't assume. Don't hide confusion. Surface tradeoffs.
- Before implementing: state assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop and clarify.

### 2. Simplicity First
- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked. No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- Keep implementations concise and clean.

### 3. Surgical Changes
- Touch only what you must. Clean up only your own mess.
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken. Match existing style.
- If changes create orphans, clean them up. Leave pre-existing code untouched unless asked.

### 4. Goal-Driven Execution
- Define success criteria and verify with tests or verifiable checks.
- For multi-step tasks, state a brief step-by-step plan with verification at each step.

---

## Frontend Design Principles
When designing and developing frontend interfaces:
- **Avoid AI Defaults:** Avoid generic SaaS card grids, generic purple/blue gradients, overused fonts (Inter, Roboto, Arial), or unnecessary all-caps / eyebrow labels.
- **Intentional Aesthetic:** Ground the design in the specific subject matter and domain of the project.
- **Typography & Hierarchy:** Pick distinct, purposeful typography with intentional scale, line length (<80 chars), and weights.
- **Deliberate Motion:** Use non-user-triggered animations sparingly and purposefully.
- **Copywriting:** Clear, active, user-focused language without generic marketing filler.

---

## Project Architecture (Video_AI — verified 2026-09-17)

- **Frontend:** React 18 + Vite 6 (`frontend/`). Scripts: `dev`, `build` (`vite build`), `lint` (`eslint . --quiet`), `typecheck`, `preview`. No `npm test`. Dark theme (#0F1117), Vite proxy `/api` → `http://localhost:3001`. Key: `src/api/client.js`, `src/pages/CreateProject.jsx`, `src/pages/ProjectDetail.jsx`, `src/components/timeline/`.
- **Backend:** Node >=18 ESM Express (`backend/server.js`, `backend/src/`). Scripts: `dev`/`start` (`node server.js`), `check:redis`, `test` (`node scripts/run-tests.mjs` → all `backend/tests/*.test.mjs`, ~36 files). Routes under `src/routes/v1/`, health `GET /health` → `{status, redis, queueSystem}`.
- **Modes:** SUMMARY vs TRANSLATE_DUB (target spec in `Video_AI_docs/docs/`, legacy STYLE_EDIT code being removed). 13 translation style presets via `GET /style-presets`. Resumable TUS-like upload (`POST /uploads/init`, `PUT /uploads/:id/chunk`, `POST /uploads/:id/complete`), SSE `GET /projects/:id/events`, storage served at `/storage/<key>`.
- **Pipeline stages** (`backend/src/pipeline/stages/`): `dubIngest → dubStt ‖ dubOcr → dubTranslate → dubTtsAlign → dubMerge → dubRender`; `summaryTranscribe → summaryAnalyze → summaryScript → summarySceneDetect → summaryAlign → summarySubtitle → summaryTts → summaryRender`.
- **Workers/queue:** BullMQ + Redis (`src/queue/`). `docker-compose.yml` services: `redis` (6379), `api` (3001), `worker` (profile `scale`), `web` (80). Redis NOT guaranteed running locally — probe via `npm run check:redis` or `/health`, never assume.
- **Database:** SQLite via `sql.js` (`src/db/`), `DATABASE_URL=file:./data.db`. Seeds in `src/db/seed.js`.
- **FFmpeg:** via `src/media/ffmpeg.js` (+ `FFMPEG_PATH` in `backend/.env`). NOT installed on this machine (2026-09-17) — mark FFmpeg checks SKIP/BLOCKED with reason, never PASS by assumption.
- **AI services:** keys via env (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`); SMTP/quota vars in `docker-compose.yml`. Secrets: UNKNOWN values, never log.
- **Docker:** `docker/api.Dockerfile`, `docker/web.Dockerfile`, `docker-compose.yml` as above.
- **Existing agent/config (do not break):** `.opencode/plans/`, `.agents/plugins/` (playwright), `.agents/skills/` (10), `.cursor/agents/` (4 impeccable) + `hooks.json` + `mcp.json`, `.mcp.json` (playwright), `.ai-workflow/` (this pipeline). Merge safely, never delete.

## Environment Rules

- Backend first (`cd backend; npm run dev`), then frontend (`cd frontend; npm run dev`).
- Never commit `.env` (root `.gitignore` covers `.env`, `node_modules/`, `dist/`, `backend/data.db`, `backend/storage/`, `*.log`).
- Never log secrets, API keys, tokens. Pipeline logs are redacted.
- FFmpeg/Redis/DB availability: probe, don't assume. Record actual versions in test reports.

## Testing Rules

- Backend: `cd backend; npm test`. This is the regression gate — run it fully, don't stop at HTTP 200.
- Frontend: `cd frontend; npm run lint` and `npm run build`. There is no frontend `npm test` — don't invent one.
- Contract: `frontend/src/api/*` usage must match `backend/src/routes/` responses; verify on every API change.
- Video pipeline: check only touched `dub*`/`summary*` stages in isolation, plus the full backend suite for regression.

## Git Rules

- Allowed: `git status`, `git diff`, `git log`, `git branch --show-current`.
- Forbidden for all agents and pipeline scripts: `git commit`, `git push`, `git merge`, `git reset --hard`, `git clean -fd`.
- Dirty tree at start = warning + baseline, never reset. Humans decide commit/merge/push.

## Agent Workflow (OpenCode + Antigravity)

- Pipeline: `USER → PLANNER(opencode) → CODER(opencode) → TESTER(antigravity) → [DEBUGGER(opencode) → CODER → TESTER]×2 → REVIEWER(antigravity) → HUMAN`. See `.ai-workflow/README.md`.
- Source of truth: `.ai-workflow/prompts/*.md`. Runtime adapters: `.opencode/agents/*.md`, `.agents/agents/*/agent.md`.
- File-based handoff only (`.ai-workflow/handoff/`): `00-request → 01-plan (PLAN_READY) → 02-changes (IMPLEMENTED) → 03-test-results (TEST_PASS) → [04-debug (DEBUG_READY)] → 05-review (APPROVED)`. No agent may depend on another's conversation context.
- Run: `.\.ai-workflow\run-pipeline.ps1 "request"` · `-Validate` · `-Status` · `-Resume` · `-DryRun`.
- No Claude Code dependency. No auto commit/push/merge. No `--dangerously-skip-permissions` by default.

## Security Rules

- Don't read secrets unless needed; never log or commit them; never change `.env` or auth outside scope.
- Never disable auth/CORS/validation or security checks to make tests pass.
- Least-privilege headless execution; permission matrix: Planner R-only; Coder R/W/Bash; Tester R+Bash(tests); Debugger R+Bash(probe); Reviewer R-only + git-inspect.

## Coding Rules

- Karpathy principles above apply to every agent (think first, simplicity first, surgical changes, verify with tests).
- Match existing style; no speculative abstractions or out-of-scope "improvements".
