# Pipeline Readiness

Status: READY

## Discovery
- **Agent**: `discovery` (Antigravity adapter `.agents/agents/discovery/agent.md`, OpenCode fallback `.opencode/agents/discovery.md`, shared prompt `.ai-workflow/prompts/discovery.md`).
- **Invocation**: Fresh headless Antigravity session using `agy -p "<prompt>" --output-format json --add-dir D:\E\Video_AI --print-timeout 15m --effort medium --agent discovery`.
- **Root Cause Fixed**: PowerShell `Start-Process -ArgumentList $argList` array parameter splitting bug was identified and resolved using `Build-NativeArguments` string formatting and explicit `-WorkingDirectory $ProjectRoot`.
- **Output Contract**: Canonical file `D:\E\Video_AI\.ai-workflow\autopilot\latest-scan.md` verified and generated.
- **Status Contract**: Machine-readable marker `FINAL_STATUS: SCAN_DONE` verified in output and artifact. Graceful handling of `NO_ACTIONABLE_FINDINGS` implemented.
- **History Archiving**: Scan history snapshots copied to `.ai-workflow/autopilot/discovery/history/YYYYMMDD-HHMMSS-scan.md`.

## Backlog
- **Directory**: `D:\E\Video_AI\.ai-workflow\autopilot\backlog/` (`pending`, `active`, `completed`, `failed`, `rejected`).
- **Convention**: `TASK-<NNN>-<slug>.md` with metadata blocks (`## Title`, `## Type`, `## Priority`, `## Autonomy`, `## Evidence`, `## Affected Areas`, `## Expected Outcome`, `## Constraints`, `## Suggested Verification`, `## Status`).
- **Current Findings**: 7 high-value engineering tasks discovered and populated into `backlog/pending/` across bug fixes, pipeline stage wiring, queue worker fixes, and integration tests.
- **Deduplication & Ranking**: Deterministic priority ranking verified in `.ai-workflow/autopilot/proposals/ranking.md`.

## Runtime Mapping
- **Planner**: `opencode`
- **Coder**: `opencode`
- **Tester**: `antigravity`
- **Debugger**: `opencode`
- **Reviewer**: `antigravity`
- **Configuration**: Enforced in `.ai-workflow/state/workflow.json` and validated by `autopilot.ps1 -Validate`.

## OpenCode Model
- **Config**: `.opencode/opencode.json` configured with schema and model `opencode/muse-spark-1.3-contributor-free`.
- **CLI**: OpenCode v1.18.31 available and verified.

## Antigravity
- **CLI**: Antigravity v1.2.5 (`agy.exe`) available and verified.
- **Agents**: Adapters in `.agents/agents/` for discovery, prioritizer, planner, coder, tester, debugger, reviewer verified.

## Fresh Sessions
- **Per-Task Isolation**: Each task starts a fresh PowerShell process running `run-pipeline.ps1` with isolated logs in `.ai-workflow/logs/` and snapshots in `.ai-workflow/sessions/<task-id>/`.
- **No Shared Conversation**: Zero `--continue` usage across tasks in autopilot loop.

## Retry
- **Mechanism**: `maxAttemptsPerTask = 2`.
- **Loop**: `TEST_FAIL` triggers Debugger (OpenCode, diagnosis only) -> Coder (OpenCode, surgical fix) -> Tester (Antigravity retest).

## Completion Gate
- **Criteria**: Task moves to `backlog/completed/` only upon `status == "COMPLETE"` and `lastResult` matching `APPROVED` (IMPLEMENTED + TEST_PASS + APPROVED).
- **Failure**: Persistent failure moves task to `backlog/failed/` without blocking subsequent tasks.

## 10 Task Limit
- **Enforcement**: `-Tasks` clamped to maximum 10 (`[int]$Tasks = 10`).
- **Stopping condition**: Loop halts when completed tasks reach target, stop file `.ai-workflow/state/autopilot.stop` is detected, or no safe tasks remain.

## Git Safety
- **Rules**: Zero automated commits, pushes, merges, resets, or cleans.
- **Verification**: Working tree baseline recorded on startup; all changes require explicit human review and approval.

## Validation
- **Autopilot Validation**: `.\.ai-workflow\autopilot.ps1 -Validate` passes all 16 checks.
- **Pipeline Validation**: `.\.ai-workflow\run-pipeline.ps1 -Validate` passes all 10 checks.

## Dry Run
- **Execution**: `.\.ai-workflow\autopilot.ps1 -DryRun` successfully resolves full stage pipeline (`Discovery -> Backlog -> Task selection -> Planner -> Coder -> Tester -> Debugger -> Reviewer -> Completion gate`) across all 7 pending tasks without touching source code.

## Remaining Issues
- None. Discovery contract, backlog generation, runtime mapping, and autopilot orchestration are fully verified and operational.
