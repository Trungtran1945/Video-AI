# Multi-Agent Pipeline (OpenCode + Antigravity)

File-based workflow. One command → Planner → Coder → Tester → (Debugger → Coder → Tester, max 2 retries) → Reviewer → human approval.

For autonomous multi-task operation, see **Autopilot** below.

## Quick start

```powershell
.\.ai-workflow\run-pipeline.ps1 "Fix subtitle rendering"
.\.ai-workflow\run-pipeline.ps1 -Request "Fix subtitle rendering" -MaxRetries 2
.\.ai-workflow\run-pipeline.ps1 -Validate
.\.ai-workflow\run-pipeline.ps1 -Status
.\.ai-workflow\run-pipeline.ps1 -Resume
.\.ai-workflow\run-pipeline.ps1 -Request "Fix subtitle rendering" -DryRun
```

## Architecture

```text
USER REQUEST (00-request.md)
  → PLANNER (opencode) → 01-plan.md [PLAN_READY | NEEDS_CLARIFICATION]
  → CODER (opencode) → 02-changes.md [IMPLEMENTED | BLOCKED]
  → TESTER (antigravity) → 03-test-results.md [TEST_PASS | TEST_FAIL | TEST_BLOCKED]
      ├── PASS → REVIEWER (antigravity) → 05-review.md [APPROVED | CHANGES_REQUIRED | BLOCKED]
      └── FAIL → DEBUGGER (opencode) → 04-debug.md [DEBUG_READY] → CODER → TESTER (max 2 retries)
  → HUMAN APPROVAL (pipeline stops; you run git commit/push yourself)
```

## Agent roles

| Agent | Runtime | Can edit? | Can run bash? | Output |
|-------|---------|-----------|---------------|--------|
| planner | opencode | NO | NO | `handoff/01-plan.md` |
| coder | opencode | YES | YES | `handoff/02-changes.md` |
| tester | antigravity | NO | YES (tests only) | `handoff/03-test-results.md` |
| debugger | opencode | NO | YES (read-only probe) | `handoff/04-debug.md` |
| reviewer | antigravity | NO | limited (git inspect) | `handoff/05-review.md` |

All 5 roles also exist as OpenCode fallback agents (`.opencode/agents/`) so the
workflow can run on OpenCode alone if Antigravity is unavailable (override
`runtime` in `state/workflow.json`).

## Runtime override (environment adaptation)

The default map is planner/coder/debugger = opencode, tester/reviewer =
antigravity. If one CLI has no API access in your environment, point every
stage at the working runtime, e.g. all `antigravity`:

```powershell
# state/workflow.json -> runtime: all five stages "antigravity"
.\.ai-workflow\run-pipeline.ps1 -Validate
```

Behavior is identical because both runtimes execute the same shared prompts in
`.ai-workflow/prompts/`. Verified 2026-09-17: this machine runs all stages on
antigravity (opencode API unreachable here); `mode: all` is set on OpenCode
agents so `opencode run --agent <name>` works where the API is reachable.

## OpenCode vs Antigravity

- **OpenCode** (`opencode run --agent <name> "<msg>"`, v1.18.31 verified):
  planner, coder, debugger. Agent files: `.opencode/agents/*.md`
  (frontmatter `description` + `mode: subagent` + `permission`).
- **Antigravity** (`agy -p "<msg>" --output-format json --agent <name>`, v1.2.5 verified):
  tester, reviewer. Agent files: `.agents/agents/*/agent.md`.
  If `--agent <name>` is unknown server-side, the orchestrator retries without
  it — the shared prompt in `.ai-workflow/prompts/` carries the role, so the
  stage still works.
- **Source of truth**: `.ai-workflow/prompts/*.md`. Runtime agent files are thin
  adapters pointing at these. Never duplicate logic — edit the shared prompt.

## Handoff (file-based, no shared conversation context)

```text
.ai-workflow/handoff/00-request.md       user request (written by orchestrator)
.ai-workflow/handoff/01-plan.md          plan + PLAN_READY / NEEDS_CLARIFICATION
.ai-workflow/handoff/02-changes.md       diff summary + IMPLEMENTED / BLOCKED
.ai-workflow/handoff/03-test-results.md  matrix + TEST_PASS / TEST_FAIL / TEST_BLOCKED
.ai-workflow/handoff/04-debug.md         root cause + DEBUG_READY (retries only)
.ai-workflow/handoff/05-review.md        gate + APPROVED / CHANGES_REQUIRED / BLOCKED
```

Each agent ends its reply with `FINAL_STATUS: <STATUS>`; the orchestrator parses
that AND verifies the artifact file exists. Exit code 0 alone is never PASS.

## State

- `state/workflow.json` — status, currentStage, stages, iteration, runtime map, artifacts.
- `state/iteration.json` — retry counter + history.
- `-Resume` continues from the last valid artifact instead of restarting.

## Retry / debug

`MAX_RETRIES = 2` (override `-MaxRetries`). `TEST_FAIL` → debugger diagnoses
(no code edits) → coder applies fix → tester re-runs. Still failing → `BLOCKED`.

## Review

Reviewer checks correctness, architecture, security, error handling, regression,
maintainability, performance, API/DB/worker/FFmpeg safety — read-only.
`APPROVED` stops the pipeline for human inspection. `CHANGES_REQUIRED` blocks
with a required-changes list.

## Git safety

- Allowed: `git status`, `git diff`, `git log`, `git branch --show-current`.
- Forbidden (agents AND orchestrator): `commit`, `push`, `merge`,
  `reset --hard`, `clean -fd`. Dirty tree at start = warning + baseline log, never reset.
- After `APPROVED`, run `git status` / `git diff` yourself and decide.

## Security

- Never read/log secrets unless required; logs are redacted (`***REDACTED***`).
- Never commit `.env`. Never weaken auth/CORS/validation to make tests pass.
- Never use `--dangerously-skip-permissions` unless the human explicitly asks.

## Video_AI test mapping (tester must detect, never assume)

- Backend: `cd backend; npm test` (`scripts/run-tests.mjs`, ~36 `*.test.mjs` files).
- Redis probe: `cd backend; npm run check:redis`.
- Frontend: `cd frontend; npm run lint` + `npm run build` (no `npm test` exists).
- Health: `GET /health` → `{status, redis, queueSystem}`.
- FFmpeg/ffprobe: may be absent locally — report `NOT_INSTALLED`, mark SKIP with reason.
- Pipeline stages: `backend/src/pipeline/stages/` (`dub*`, `summary*`) — check only touched stages + full suite as regression gate.

## Timeouts (default, override `-MaxStageMinutes`)

planner 15 · coder 30 · tester 20 · debugger 20 · reviewer 15 (minutes).
Timeout → `STAGE_TIMEOUT` → pipeline stops safely.
`agy` runs get matching `--print-timeout` and per-stage `--effort`
(planner/coder/debugger/reviewer `medium`, tester `low`).

## Logs

`.ai-workflow/logs/YYYYMMDD-HHMMSS/{planner,coder,tester,debugger,reviewer,pipeline}.log`
plus `git-baseline-status.txt` when the tree was dirty at start.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `VALIDATION FAILED` | Run `-Validate`, install missing CLI (`opencode`/`agy`), check agent files. |
| No `FINAL_STATUS` in output | Agent didn't follow prompt; check stage log, re-run stage. |
| `BLOCKED` after retries | See `03-test-results.md` + `04-debug.md`; fix manually, then `-Resume`. |
| `NEEDS_CLARIFICATION` | Answer `Open Questions` in `01-plan.md`, re-run with refined request. |
| `CHANGES_REQUIRED` | Address `Required Changes` in `05-review.md`, re-run. |
| agy `--agent` unknown | Expected when no server-side agent is registered; orchestrator auto-retries with prompt-only mode. |
| FFmpeg `NOT_INSTALLED` | Install FFmpeg or set `FFMPEG_PATH` in `backend/.env`; render-stage tests stay SKIP until then. |
| Redis disconnected | Start redis (`docker compose up redis`) or accept queue-dependent tests as BLOCKED. |

## Adding new agents

1. Add role prompt to `.ai-workflow/prompts/<name>.md` (role, inputs, outputs, constraints, `FINAL_STATUS` contract).
2. Add OpenCode adapter `.opencode/agents/<name>.md` (frontmatter `description`, `mode: all`, `permission`).
3. Add Antigravity adapter `.agents/agents/<name>/agent.md` (frontmatter `name`, `description`, `model: inherit`, `readonly`).
4. Wire the stage into `run-pipeline.ps1` + `state/workflow.json` (`runtime`, `stages`, `artifacts`).
5. Run `-Validate` then a `-DryRun`.

---

# Autopilot (autonomous loop, max 10 tasks)

```powershell
.\.ai-workflow\autopilot.ps1              # full loop: scan -> tasks -> report
.\.ai-workflow\autopilot.ps1 -Scan        # discovery scan only (no code)
.\.ai-workflow\autopilot.ps1 -Plan        # scan + backlog + ranking (no code)
.\.ai-workflow\autopilot.ps1 -Run -Tasks 5
.\.ai-workflow\autopilot.ps1 -Status
.\.ai-workflow\autopilot.ps1 -Resume      # recover after crash/stop
.\.ai-workflow\autopilot.ps1 -Stop        # safe stop after current task
.\.ai-workflow\autopilot.ps1 -Validate
.\.ai-workflow\autopilot.ps1 -DryRun
```

## How it works

1. **Discover** (agent `discovery`, fresh headless session): scans source
   (never `node_modules/dist/.git/storage/logs`), writes
   `autopilot/discovery/latest-scan.md` (+ history copy) and one file per
   finding in `autopilot/backlog/pending/TASK-NNN-slug.md`.
2. **Deduplicate + rank** (deterministic PowerShell, same policy as
   `prompts/prioritizer.md`): critical → high → medium → low, then
   bug → security → test → performance → refactor → documentation → feature.
   Tasks needing human approval move to `backlog/rejected/` with reason.
3. **Execute** (fresh session per task): moves the file `pending → active`,
   clears shared `handoff/`, spawns a NEW `run-pipeline.ps1` process
   (`-Request <title> -MaxRetries 2`). No `--continue` across tasks — memory
   is file-based only (`sessions/TASK-XXX/` + backlog + state).
4. **Snapshot**: copies handoff artifacts, pipeline output, `git diff --stat`
   and a summary into `sessions/TASK-XXX/`; moves backlog `active →
   completed/` (only on IMPLEMENTED + TEST_PASS + APPROVED) or `→ failed/`.
5. **Repeat**: light re-rank after each task, full re-scan every 3 tasks or
   when the backlog is empty, until the target (max 10) is reached, `-Stop`
   is requested, or no safe task remains.
6. **Report**: `autopilot/reports/final-report.md`, then `AUTOPILOT_COMPLETE`.

## Session isolation

- `sessions/TASK-XXX/`: `task.md`, `session.json` (run id, timestamps,
  extracted Antigravity `conversation_id`s), `planner/coder/tester/debug/review-result.md`,
  `pipeline-output.txt`, `git-diff-stat.txt`, `summary.md`.
- `state/autopilot-state.json`: counters, current task, per-task records.
- Crash mid-task → `-Resume` marks it `RECOVERY_REQUIRED` (never assumed
  complete) and re-queues it for a fresh session.

## Safety

Same rules as the single-task pipeline (no commit/push/merge/reset/clean,
redacted logs) plus `autopilot/policies/autonomy-policy.yaml`: `autoExecute`
runs freely, `autoExecuteWithExtraVerification` runs under the normal
tester+reviewer gates, `requireHumanApproval` is rejected to `rejected/`,
`neverAutoExecute` is never run.

## Antigravity headless note

Headless `agy -p` soft-denies any tool needing approval (single denial aborts
the run). Required one-time setup, already applied on this machine:
`~/.gemini/antigravity-cli/settings.json` → `permissions.allow` scoped to the
project (`read_file`/`write_file` under `D:/E/Video_AI`, `command(git/npm/node/...)`).
All prompts additionally forbid MCP/browser/URL tools in headless runs.
