<# .SYNOPSIS
  Multi-agent engineering pipeline orchestrator: OpenCode + Antigravity.
  Planner -> Coder -> Tester -> (Debugger -> Coder -> Tester)* -> Reviewer -> Human approval.
.DESCRIPTION
  File-based handoff via .ai-workflow/handoff/, state via .ai-workflow/state/workflow.json
  and iteration.json. Never commits, pushes, merges, or resets. Stops for human approval.
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 "Fix subtitle rendering"
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 -Request "Fix subtitle rendering" -MaxRetries 2
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 -Validate
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 -Status
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 -Resume
.EXAMPLE
  .\.ai-workflow\run-pipeline.ps1 -Request "Fix subtitle rendering" -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $false)]
  [string]$Request = "",
  [int]$MaxRetries = 2,
  [string]$Mode = "Auto",
  [int]$MaxStageMinutes = 0,
  [switch]$DryRun,
  [switch]$Validate,
  [switch]$Status,
  [switch]$Resume,
  [switch]$SkipPermissions
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$WorkflowDir = Join-Path $ProjectRoot ".ai-workflow"
$HandoffDir = Join-Path $WorkflowDir "handoff"
$StateDir = Join-Path $WorkflowDir "state"
$PromptsDir = Join-Path $WorkflowDir "prompts"
$LogsRoot = Join-Path $WorkflowDir "logs"
$WorkflowFile = Join-Path $StateDir "workflow.json"
$IterationFile = Join-Path $StateDir "iteration.json"

$StageTimeouts = @{
  planner  = 15
  coder    = 30
  tester   = 20
  debugger = 20
  reviewer = 15
}

# Reasoning effort per stage (agy --effort low|medium|high). Keeps small
# tasks fast without weakening the final gates more than necessary.
$StageEffort = @{
  planner  = "medium"
  coder    = "medium"
  tester   = "low"
  debugger = "medium"
  reviewer = "medium"
}

$Global:RunLogDir = $null
$Global:PipelineLog = $null

function Write-PipeLog([string]$Msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
  Write-Host $line
  if ($Global:PipelineLog) { Add-Content -LiteralPath $Global:PipelineLog -Value $line }
}

function Redact-Secrets([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $Text }
  $patterns = @(
    '(?i)(api[_-]?key|secret|token|password|passwd|authorization\s*:\s*bearer)\s*[:=]\s*[^\s''"]+',
    '(?i)(sk-[A-Za-z0-9\-_]{8,})',
    '(?i)(xox[bap]-[A-Za-z0-9\-_]+)',
    '(?i)(gh[pousr]_[A-Za-z0-9_]+)'
  )
  $out = $Text
  foreach ($p in $patterns) { $out = [regex]::Replace($out, $p, '$1=***REDACTED***') }
  return $out
}

function Read-JsonFile([string]$Path) {
  $raw = Get-Content -LiteralPath $Path -Raw
  return $raw | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Obj) {
  $json = $Obj | ConvertTo-Json -Depth 10
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Set-JsonProp($Obj, [string]$Name, $Value) {
  if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value }
  else { $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Update-Workflow([string]$Status, [string]$Stage) {
  $wf = Read-JsonFile $WorkflowFile
  if ($Status) { $wf.status = $Status }
  if ($Stage) { $wf.currentStage = $Stage }
  $wf.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-JsonFile $WorkflowFile $wf
}

function Set-StageState([string]$Stage, [string]$Value) {
  $wf = Read-JsonFile $WorkflowFile
  $wf.stages.$Stage = $Value
  $wf.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-JsonFile $WorkflowFile $wf
}

function Get-StageTimeoutMinutes([string]$Stage) {
  if ($MaxStageMinutes -gt 0) { return $MaxStageMinutes }
  return $StageTimeouts[$Stage]
}

function Test-Artifact([string]$FileName, [string]$MustContain) {
  $p = Join-Path $HandoffDir $FileName
  if (-not (Test-Path -LiteralPath $p)) { return $false }
  if ($MustContain) {
    $c = Get-Content -LiteralPath $p -Raw
    if ($c -notmatch $MustContain) { return $false }
  }
  return $true
}

function Parse-FinalStatus([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $m = [regex]::Match($Text, 'FINAL_STATUS:\s*([A-Z_]+)')
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

function Get-CommandPath([string]$Name) {
  $c = Get-Command $Name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

function Resolve-Cli([string]$Name) {
  $all = @(Get-Command -All $Name -ErrorAction SilentlyContinue | ForEach-Object { $_.Source } | Select-Object -Unique)
  if (-not $all -or $all.Count -eq 0) { return $null }
  $exe = $all | Where-Object { $_ -match '\.exe$' } | Select-Object -First 1
  if ($exe) { return @{ Exe = $exe; Prefix = @() } }
  $ps1 = $all | Where-Object { $_ -match '\.ps1$' } | Select-Object -First 1
  if ($ps1) { return @{ Exe = "powershell"; Prefix = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ps1) } }
  $cmd = $all | Where-Object { $_ -match '\.(cmd|bat)$' } | Select-Object -First 1
  if ($cmd) { return @{ Exe = "cmd"; Prefix = @("/c", $cmd) } }
  return @{ Exe = $all[0]; Prefix = @() }
}

function Invoke-Agent([string]$Stage, [string]$Message, [int]$TimeoutMinutes) {
  $wf = Read-JsonFile $WorkflowFile
  $runtime = $wf.runtime.$Stage
  if ([string]::IsNullOrEmpty($runtime)) { $runtime = "opencode" }
  $logFile = Join-Path $Global:RunLogDir ("{0}.log" -f $Stage)
  $timeoutMs = $TimeoutMinutes * 60 * 1000

  $exe = $null
  $args = @()
  $fallbackArgs = $null
  if ($runtime -eq "antigravity") {
    $cli = Resolve-Cli "agy"
    if (-not $cli) { throw "Antigravity CLI 'agy' not found in PATH." }
    $exe = $cli.Exe
    $agyBase = @($cli.Prefix) + @("-p", $Message, "--output-format", "json", "--add-dir", $ProjectRoot, "--print-timeout", ("{0}m" -f $TimeoutMinutes))
    if ($SkipPermissions) { $agyBase = $agyBase + @("--dangerously-skip-permissions") }
    if ($StageEffort.ContainsKey($Stage)) { $agyBase = $agyBase + @("--effort", $StageEffort[$Stage]) }
    $args = $agyBase + @("--agent", $Stage)
    $fallbackArgs = $agyBase
  } else {
    $cli = Resolve-Cli "opencode"
    if (-not $cli) { throw "OpenCode CLI 'opencode' not found in PATH." }
    $exe = $cli.Exe
    $ocArgs = @($cli.Prefix) + @("run", "--agent", $Stage)
    if ($SkipPermissions) { $ocArgs = $ocArgs + @("--auto") }
    $args = $ocArgs + @($Message)
  }

  Write-PipeLog ("Stage '{0}' via {1} (timeout {2} min). Logging to {3}" -f $Stage, $runtime, $TimeoutMinutes, $logFile)
  Add-Content -LiteralPath $logFile -Value ("=== STAGE {0} via {1} at {2} ===" -f $Stage, $runtime, (Get-Date -Format "o"))
  Add-Content -LiteralPath $logFile -Value ("CMD: {0} {1}" -f $exe, (Build-NativeArguments $args))

  $result = Invoke-NativeWithTimeout $exe $args $timeoutMs $logFile
  if ($result.TimedOut) {
    Write-PipeLog ("Stage '{0}' TIMEOUT after {1} min." -f $Stage, $TimeoutMinutes)
    return @{ Status = "STAGE_TIMEOUT"; Output = $result.Output }
  }
  if ($result.Output -match 'no output produced|soft-deny|denied_actions') {
    Write-PipeLog ("Stage '{0}' PERMISSION_DENIED: headless tool call was soft-denied (see log)." -f $Stage)
    Stop-Blocked ("Stage '{0}': Antigravity soft-denied a tool in headless mode. Check the stage log for the named allow-rule, add it to permissions.allow in ~/.gemini/antigravity-cli/settings.json (scoped to the project), then re-run with -Resume." -f $Stage)
    Show-Status
    exit 1
  }
  # Antigravity: retry without --agent if the agent name is unknown server-side.
  if (($runtime -eq "antigravity") -and ($result.Output -match '(?i)unknown agent|agent not found|invalid.*agent') -and $fallbackArgs) {
    Write-PipeLog "Antigravity agent '$Stage' not registered server-side; retrying with shared-prompt message only."
    Add-Content -LiteralPath $logFile -Value "=== RETRY without --agent (shared prompt carries role) ==="
    $result = Invoke-NativeWithTimeout $exe $fallbackArgs $timeoutMs $logFile
    if ($result.TimedOut) {
      Write-PipeLog ("Stage '{0}' TIMEOUT after {1} min." -f $Stage, $TimeoutMinutes)
      return @{ Status = "STAGE_TIMEOUT"; Output = $result.Output }
    }
  }
  if ($result.ExitCode -ne 0) {
    Write-PipeLog ("Stage '{0}' CLI exit code {1} (continuing to status parse; artifact is source of truth)." -f $Stage, $result.ExitCode)
  }
  $status = Parse-FinalStatus $result.Output
  if (-not $status) {
    Write-PipeLog ("Stage '{0}': no FINAL_STATUS found in output; checking artifact..." -f $Stage)
  }
  return @{ Status = $status; Output = $result.Output; ExitCode = $result.ExitCode }
}

function Invoke-NativeWithTimeout([string]$Exe, [string[]]$ArgList, [int]$TimeoutMs, [string]$LogFile) {
  $outF = [System.IO.Path]::GetTempFileName()
  $errF = [System.IO.Path]::GetTempFileName()
  $argStr = Build-NativeArguments $ArgList
  $p = Start-Process -FilePath $Exe -ArgumentList $argStr -WorkingDirectory $ProjectRoot -RedirectStandardOutput $outF -RedirectStandardError $errF -PassThru -NoNewWindow
  $exited = $p.WaitForExit($TimeoutMs)
  if (-not $exited) {
    try { $p.Kill() } catch {}
    try { $p.WaitForExit(5000) } catch {}
    $partial = ""
    if (Test-Path -LiteralPath $outF) { $partial += (Get-Content -LiteralPath $outF -Raw) }
    if (Test-Path -LiteralPath $errF) { $partial += "`n" + (Get-Content -LiteralPath $errF -Raw) }
    Remove-Item $outF, $errF -Force -ErrorAction SilentlyContinue
    $partial = Redact-Secrets $partial
    Add-Content -LiteralPath $LogFile -Value "STAGE_TIMEOUT after ${TimeoutMs}ms"
    if ($partial.Trim().Length -gt 0) { Add-Content -LiteralPath $LogFile -Value ("PARTIAL OUTPUT:`n" + $partial) }
    return @{ TimedOut = $true; Output = $partial; ExitCode = -1 }
  }
  $p.WaitForExit()
  $stdout = ""; $stderr = ""
  if (Test-Path -LiteralPath $outF) { $stdout = Get-Content -LiteralPath $outF -Raw }
  if (Test-Path -LiteralPath $errF) { $stderr = Get-Content -LiteralPath $errF -Raw }
  Remove-Item $outF, $errF -Force -ErrorAction SilentlyContinue
  $combined = Redact-Secrets ($stdout + "`n" + $stderr)
  Add-Content -LiteralPath $LogFile -Value $combined
  Add-Content -LiteralPath $LogFile -Value ("EXIT: {0}" -f $p.ExitCode)
  # Antigravity --output-format json wraps the answer; unwrap for status parsing.
  $unwrapped = Unwrap-AgyJson $combined
  if ($unwrapped) { $combined = $unwrapped }
  return @{ TimedOut = $false; Output = $combined; ExitCode = $p.ExitCode }
}

function Build-NativeArguments([string[]]$ArgList) {
  $parts = @()
  foreach ($a in $ArgList) {
    if ($a -match '[\s"]') {
      $escaped = $a -replace '(\\+)"', '$1$1\"' -replace '"', '\"'
      $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
      $parts += ('"{0}"' -f $escaped)
    } else {
      $parts += $a
    }
  }
  return ($parts -join " ")
}

function Unwrap-AgyJson([string]$Text) {
  try {
    $start = $Text.IndexOf("{")
    $end = $Text.LastIndexOf("}")
    if ($start -lt 0 -or $end -le $start) { return $null }
    $candidate = $Text.Substring($start, $end - $start + 1)
    $obj = $candidate | ConvertFrom-Json -ErrorAction Stop
    if ($obj.response) { return [string]$obj.response }
  } catch {}
  return $null
}

function Build-StageMessage([string]$Stage, [string]$UserRequest) {
  $promptFile = Join-Path $PromptsDir ("{0}.md" -f $Stage)
  $lines = @()
  $lines += ("Follow .ai-workflow/prompts/{0}.md exactly (it is the source of truth)." -f $Stage)
  $lines += ("Project root: {0}." -f $ProjectRoot)
  $lines += ("User request: {0}" -f $UserRequest)
  $lines += "Read the handoff files listed in your prompt, do your stage, write your artifact, and end with the FINAL_STATUS line."
  if ($Stage -eq "coder" -and (Test-Path -LiteralPath (Join-Path $HandoffDir "04-debug.md"))) {
    $lines += "A debug report exists at .ai-workflow/handoff/04-debug.md -- apply its proposed fix on top of 01-plan.md."
  }
  return ($lines -join " ")
}

function Write-RequestFile([string]$UserRequest) {
  $content = @"
# User Request

## Request

$UserRequest

## Created At

$((Get-Date).ToUniversalTime().ToString("o"))

## Project

Video_AI

## Pipeline

OpenCode + Antigravity

## Status

RECEIVED
"@
  Set-Content -LiteralPath (Join-Path $HandoffDir "00-request.md") -Value $content -Encoding UTF8
}

function Show-Validation([switch]$Silent) {
  $checks = @()
  $checks += @{ Name = "Project exists"; Pass = (Test-Path -LiteralPath $ProjectRoot) }
  $checks += @{ Name = "Git available"; Pass = ((Get-CommandPath "git") -ne $null) }
  $checks += @{ Name = "OpenCode available"; Pass = ((Get-CommandPath "opencode") -ne $null) }
  $checks += @{ Name = "Antigravity available"; Pass = ((Get-CommandPath "agy") -ne $null) }
  $checks += @{ Name = "AGENTS.md exists"; Pass = (Test-Path -LiteralPath (Join-Path $ProjectRoot "AGENTS.md")) }
  $jsonOk = $true
  try {
    [void](Read-JsonFile $WorkflowFile)
    [void](Read-JsonFile $IterationFile)
  } catch { $jsonOk = $false }
  $checks += @{ Name = "workflow.json + iteration.json valid"; Pass = $jsonOk }
  $agentFiles = @(
    ".opencode\agents\planner.md", ".opencode\agents\coder.md", ".opencode\agents\tester.md",
    ".opencode\agents\debugger.md", ".opencode\agents\reviewer.md",
    ".agents\agents\planner\agent.md", ".agents\agents\coder\agent.md", ".agents\agents\tester\agent.md",
    ".agents\agents\debugger\agent.md", ".agents\agents\reviewer\agent.md"
  )
  $agentsOk = $true
  foreach ($rel in $agentFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $rel))) { $agentsOk = $false }
  }
  $checks += @{ Name = "Agent files exist (10)"; Pass = $agentsOk }
  $checks += @{ Name = "Handoff directory exists"; Pass = (Test-Path -LiteralPath $HandoffDir) }
  $checks += @{ Name = "PowerShell version compatible"; Pass = ($PSVersionTable.PSVersion.Major -ge 5) }
  $promptOk = $true
  foreach ($s in @("planner", "coder", "tester", "debugger", "reviewer")) {
    if (-not (Test-Path -LiteralPath (Join-Path $PromptsDir ("{0}.md" -f $s)))) { $promptOk = $false }
  }
  $checks += @{ Name = "Shared prompts exist (5)"; Pass = $promptOk }

  $allPass = $true
  foreach ($c in $checks) {
    $tag = "FAIL"
    if ($c.Pass) { $tag = "PASS" } else { $allPass = $false }
    if (-not $Silent) { Write-Host ("[{0}] {1}" -f $tag, $c.Name) }
  }
  if (-not $allPass -and -not $Silent) { Write-Host "VALIDATION FAILED" }
  return $allPass
}

function Show-Status {
  $wf = Read-JsonFile $WorkflowFile
  $it = Read-JsonFile $IterationFile
  Write-Host ""
  Write-Host ("Project:   {0}" -f $wf.project)
  Write-Host "Pipeline:  OpenCode + Antigravity"
  Write-Host ("Status:    {0}" -f $wf.status)
  Write-Host ("Stage:     {0}" -f $wf.currentStage)
  Write-Host ("Iteration: {0} / {1}" -f $it.currentIteration, $it.maxIterations)
  Write-Host ""
  foreach ($s in @("planner", "coder", "tester", "debugger", "reviewer")) {
    $v = $wf.stages.$s
    Write-Host ("{0,-10} {1}" -f ($s + ":"), $v)
  }
  if ($wf.blockedReason) { Write-Host ("Blocked:   {0}" -f $wf.blockedReason) }
  if ($wf.lastResult) { Write-Host ("Last:      {0}" -f $wf.lastResult) }
  Write-Host ""
}

function Initialize-Run([string]$UserRequest) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Global:RunLogDir = Join-Path $LogsRoot $stamp
  New-Item -ItemType Directory -Force -Path $Global:RunLogDir | Out-Null
  $Global:PipelineLog = Join-Path $Global:RunLogDir "pipeline.log"
  Write-RequestFile $UserRequest
  $wf = Read-JsonFile $WorkflowFile
  $wf.status = "RUNNING"
  $wf.startedAt = (Get-Date).ToUniversalTime().ToString("o")
  $wf.updatedAt = $wf.startedAt
  Set-JsonProp $wf "request" $UserRequest
  Set-JsonProp $wf "iteration" 0
  $wf.maxIterations = $MaxRetries
  $wf.blockedReason = $null
  $wf.lastResult = $null
  foreach ($s in @("planner", "coder", "tester", "debugger", "reviewer")) { $wf.stages.$s = "pending" }
  Write-JsonFile $WorkflowFile $wf
  $it = Read-JsonFile $IterationFile
  $it.currentIteration = 0
  $it.maxIterations = $MaxRetries
  $it.history = @()
  Write-JsonFile $IterationFile $it
  Write-PipeLog ("Pipeline started. Request: {0}" -f $UserRequest)
  try {
    $gitStatus = & git -C $ProjectRoot status --short 2>&1 | Out-String
    if ($gitStatus.Trim().Length -gt 0) {
      Write-PipeLog "WARNING: Working tree contains existing changes. Recording baseline, will not reset."
      Set-Content -LiteralPath (Join-Path $Global:RunLogDir "git-baseline-status.txt") -Value (Redact-Secrets $gitStatus) -Encoding UTF8
    }
  } catch {
    Write-PipeLog "WARNING: git status check failed; continuing."
  }
}

function Stop-Blocked([string]$Reason) {
  $wf = Read-JsonFile $WorkflowFile
  $wf.status = "BLOCKED"
  $wf.blockedReason = $Reason
  $wf.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-JsonFile $WorkflowFile $wf
  Write-PipeLog ("PIPELINE BLOCKED: {0}" -f $Reason)
}

function Stop-Complete([string]$Result) {
  $wf = Read-JsonFile $WorkflowFile
  $wf.status = "COMPLETE"
  $wf.lastResult = $Result
  $wf.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-JsonFile $WorkflowFile $wf
  Write-PipeLog ("PIPELINE COMPLETE: {0}" -f $Result)
}

# ---------------- Entry: flags ----------------

if ($Status) { Show-Status; return }
if ($Validate) {
  $ok = Show-Validation
  if (-not $ok) { exit 1 }
  return
}

if ($Resume) {
  if ([string]::IsNullOrWhiteSpace($Request)) {
    $wf0 = Read-JsonFile $WorkflowFile
    $Request = $wf0.request
  }
  if ([string]::IsNullOrWhiteSpace($Request)) { Write-Host "Nothing to resume (no stored request)."; exit 1 }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Global:RunLogDir = Join-Path $LogsRoot $stamp
  New-Item -ItemType Directory -Force -Path $Global:RunLogDir | Out-Null
  $Global:PipelineLog = Join-Path $Global:RunLogDir "pipeline.log"
  Write-PipeLog ("Resuming pipeline from state. Request: {0}" -f $Request)
} else {
  if ($Validate -or $Status) { return }
  if ([string]::IsNullOrWhiteSpace($Request)) {
    if ($args.Count -gt 0) { $Request = ($args -join " ") }
  }
  if ([string]::IsNullOrWhiteSpace($Request) -and -not $DryRun) {
    Write-Host 'Usage: .\.ai-workflow\run-pipeline.ps1 "Your request" [-MaxRetries 2] [-DryRun] [-Validate] [-Status] [-Resume]'
    exit 1
  }
  if ($DryRun) {
    Write-Host "DRY RUN -- validating only, no agents will be called."
    $ok = Show-Validation
    Write-Host ""
    Write-Host "Planned stages: PLANNER(opencode) -> CODER(opencode) -> TESTER(antigravity) -> [DEBUGGER(opencode) -> CODER -> TESTER] x$MaxRetries -> REVIEWER(antigravity) -> HUMAN APPROVAL"
    Write-Host ("Request: {0}" -f $Request)
    if (-not $ok) { exit 1 }
    return
  }
  Initialize-Run $Request
}

# ---------------- Main state machine ----------------

$wf = Read-JsonFile $WorkflowFile
$storedRequest = $wf.request
if ([string]::IsNullOrWhiteSpace($Request)) { $Request = $storedRequest }

function Skip-IfArtifactValid([string]$Stage, [string]$Artifact, [string]$Pattern) {
  if ($Resume -and (Test-Artifact $Artifact $Pattern)) {
    Write-PipeLog ("Resume: artifact {0} already valid -- skipping {1}." -f $Artifact, $Stage)
    Set-StageState $Stage "completed"
    return $true
  }
  return $false
}

# PLANNER
if (-not (Skip-IfArtifactValid "planner" "01-plan.md" "PLAN_READY|NEEDS_CLARIFICATION")) {
  Update-Workflow "PLANNING" "planner"
  Set-StageState "planner" "running"
  $r = Invoke-Agent "planner" (Build-StageMessage "planner" $Request) (Get-StageTimeoutMinutes "planner")
  if ($r.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Planner timeout."; Show-Status; exit 1 }
  $planText = ""
  $planPath = Join-Path $HandoffDir "01-plan.md"
  if (Test-Path -LiteralPath $planPath) { $planText = Get-Content -LiteralPath $planPath -Raw }
  if (-not (Test-Path -LiteralPath $planPath) -and ($r.Output -match '(?ms)(# Implementation Plan.*)')) {
    $planText = $matches[1].Trim()
    Set-Content -LiteralPath $planPath -Value $planText -Encoding UTF8
  }
  $planStatus = Parse-FinalStatus ($r.Output + "`n" + $planText)
  if ($planStatus -eq "NEEDS_CLARIFICATION") {
    Set-StageState "planner" "needs_clarification"
    Update-Workflow "WAITING_FOR_HUMAN" "planner"
    Write-PipeLog "Planner needs clarification. See .ai-workflow/handoff/01-plan.md Open Questions. Pipeline STOP."
    Show-Status
    return
  }
  if ($planStatus -ne "PLAN_READY" -or -not (Test-Path -LiteralPath $planPath)) {
    Set-StageState "planner" "failed"
    Stop-Blocked "Planner did not produce 01-plan.md with PLAN_READY."
    Show-Status
    exit 1
  }
  Set-StageState "planner" "completed"
  Update-Workflow "PLAN_READY" "coder"
}

# CODER (initial)
if (-not (Skip-IfArtifactValid "coder" "02-changes.md" "IMPLEMENTED|BLOCKED")) {
  Update-Workflow "CODING" "coder"
  Set-StageState "coder" "running"
  $r = Invoke-Agent "coder" (Build-StageMessage "coder" $Request) (Get-StageTimeoutMinutes "coder")
  if ($r.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Coder timeout."; Show-Status; exit 1 }
  $changesPath = Join-Path $HandoffDir "02-changes.md"
  $changesText = ""
  if (Test-Path -LiteralPath $changesPath) { $changesText = Get-Content -LiteralPath $changesPath -Raw }
  if (-not (Test-Path -LiteralPath $changesPath) -and ($r.Output -match '(?ms)(# Changes.*)')) {
    $changesText = $matches[1].Trim()
    Set-Content -LiteralPath $changesPath -Value $changesText -Encoding UTF8
  }
  $coderStatus = Parse-FinalStatus ($r.Output + "`n" + $changesText)
  if ($coderStatus -ne "IMPLEMENTED" -or -not (Test-Path -LiteralPath $changesPath)) {
    Set-StageState "coder" "failed"
    Stop-Blocked "Coder did not produce 02-changes.md with IMPLEMENTED."
    Show-Status
    exit 1
  }
  Set-StageState "coder" "completed"
}

# TESTER with retry loop
$attempt = 0
$testerFinal = $null
$lastTesterFileStatus = $null
while ($true) {
  if ($Resume -and (Test-Artifact "03-test-results.md" "TEST_PASS|TEST_FAIL|TEST_BLOCKED")) {
    $t = Get-Content -LiteralPath (Join-Path $HandoffDir "03-test-results.md") -Raw
    $testerFinal = Parse-FinalStatus $t
    if (-not $testerFinal) {
      if ($t -match "TEST_PASS") { $testerFinal = "TEST_PASS" }
      elseif ($t -match "TEST_BLOCKED") { $testerFinal = "TEST_BLOCKED" }
      else { $testerFinal = "TEST_FAIL" }
    }
    Write-PipeLog ("Resume: reusing existing test result {0}." -f $testerFinal)
    Set-StageState "tester" "completed"
    break
  }
  Update-Workflow "TESTING" "tester"
  Set-StageState "tester" "running"
  $r = Invoke-Agent "tester" (Build-StageMessage "tester" $Request) (Get-StageTimeoutMinutes "tester")
  if ($r.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Tester timeout."; Show-Status; exit 1 }
  $testsPath = Join-Path $HandoffDir "03-test-results.md"
  $testsText = ""
  if (Test-Path -LiteralPath $testsPath) { $testsText = Get-Content -LiteralPath $testsPath -Raw }
  if (-not (Test-Path -LiteralPath $testsPath) -and ($r.Output -match '(?ms)(# Test Results.*)')) {
    $testsText = $matches[1].Trim()
    Set-Content -LiteralPath $testsPath -Value $testsText -Encoding UTF8
  }
  $testerFinal = Parse-FinalStatus ($r.Output + "`n" + $testsText)
  if (-not (Test-Path -LiteralPath $testsPath) -or -not $testerFinal) {
    Set-StageState "tester" "failed"
    Stop-Blocked "Tester produced no artifact or FINAL_STATUS (PIPELINE_ERROR)."
    Show-Status
    exit 1
  }
  Set-StageState "tester" "completed"
  $lastTesterFileStatus = $testerFinal

  if ($testerFinal -eq "TEST_PASS") { break }
  if ($testerFinal -eq "TEST_BLOCKED") {
    Stop-Blocked "Tester reported TEST_BLOCKED. See 03-test-results.md."
    Show-Status
    exit 1
  }
  if ($testerFinal -ne "TEST_FAIL") {
    Stop-Blocked ("Tester returned unrecognized status '{0}'." -f $testerFinal)
    Show-Status
    exit 1
  }
  # TEST_FAIL -> retry?
  if ($attempt -ge $MaxRetries) {
    Stop-Blocked ("Tests still failing after {0} retries (max {1}). See 03-test-results.md + 04-debug.md." -f $attempt, $MaxRetries)
    Show-Status
    exit 1
  }
  $attempt = $attempt + 1
  $it = Read-JsonFile $IterationFile
  $it.currentIteration = $attempt
  Write-JsonFile $IterationFile $it
  $wf2 = Read-JsonFile $WorkflowFile
  Set-JsonProp $wf2 "iteration" $attempt
  Write-JsonFile $WorkflowFile $wf2
  Write-PipeLog ("TEST_FAIL -- retry {0}/{1}: running DEBUGGER." -f $attempt, $MaxRetries)
  Update-Workflow "DEBUGGING" "debugger"
  Set-StageState "debugger" "running"
  $d = Invoke-Agent "debugger" (Build-StageMessage "debugger" $Request) (Get-StageTimeoutMinutes "debugger")
  if ($d.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Debugger timeout."; Show-Status; exit 1 }
  $debugPath = Join-Path $HandoffDir "04-debug.md"
  $debugText = ""
  if (Test-Path -LiteralPath $debugPath) { $debugText = Get-Content -LiteralPath $debugPath -Raw }
  if (-not (Test-Path -LiteralPath $debugPath) -and ($d.Output -match '(?ms)(# Debug.*)')) {
    $debugText = $matches[1].Trim()
    Set-Content -LiteralPath $debugPath -Value $debugText -Encoding UTF8
  }
  $debugStatus = Parse-FinalStatus ($d.Output + "`n" + $debugText)
  if ($debugStatus -ne "DEBUG_READY" -or -not (Test-Path -LiteralPath $debugPath)) {
    Set-StageState "debugger" "failed"
    Stop-Blocked ("Debugger did not produce 04-debug.md with DEBUG_READY (got '{0}')." -f $debugStatus)
    Show-Status
    exit 1
  }
  Set-StageState "debugger" "completed"
  Write-PipeLog "DEBUG_READY -- re-running CODER with fix."
  Update-Workflow "RETRYING" "coder"
  Set-StageState "coder" "running"
  $c2 = Invoke-Agent "coder" (Build-StageMessage "coder" $Request) (Get-StageTimeoutMinutes "coder")
  if ($c2.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Coder (retry) timeout."; Show-Status; exit 1 }
  $changesText2 = Get-Content -LiteralPath (Join-Path $HandoffDir "02-changes.md") -Raw
  $coderStatus2 = Parse-FinalStatus ($c2.Output + "`n" + $changesText2)
  if ($coderStatus2 -ne "IMPLEMENTED") {
    Set-StageState "coder" "failed"
    Stop-Blocked "Coder (retry) did not return IMPLEMENTED."
    Show-Status
    exit 1
  }
  Set-StageState "coder" "completed"
  $it3 = Read-JsonFile $IterationFile
  $entry = @{ iteration = $attempt; tester = "FAIL"; debugger = "ROOT_CAUSE_FOUND"; coder = "FIX_APPLIED"; testerRetry = "PENDING" }
  $it3.history = @($it3.history) + @($entry)
  Write-JsonFile $IterationFile $it3
  # loop continues -> tester again
}

if ($testerFinal -ne "TEST_PASS") {
  Stop-Blocked ("Unexpected tester end state '{0}'." -f $testerFinal)
  Show-Status
  exit 1
}
Update-Workflow "TEST_PASS" "reviewer"
# mark last retry entry passed
try {
  $it4 = Read-JsonFile $IterationFile
  if ($it4.history -and $it4.history.Count -gt 0) {
    $it4.history[$it4.history.Count - 1].testerRetry = "PASS"
    Write-JsonFile $IterationFile $it4
  }
} catch {}

# REVIEWER
if (-not (Skip-IfArtifactValid "reviewer" "05-review.md" "APPROVED|CHANGES_REQUIRED|BLOCKED")) {
  Update-Workflow "REVIEWING" "reviewer"
  Set-StageState "reviewer" "running"
  $r = Invoke-Agent "reviewer" (Build-StageMessage "reviewer" $Request) (Get-StageTimeoutMinutes "reviewer")
  if ($r.Status -eq "STAGE_TIMEOUT") { Stop-Blocked "Reviewer timeout."; Show-Status; exit 1 }
  $reviewPath = Join-Path $HandoffDir "05-review.md"
  $reviewText = ""
  if (Test-Path -LiteralPath $reviewPath) { $reviewText = Get-Content -LiteralPath $reviewPath -Raw }
  if (-not (Test-Path -LiteralPath $reviewPath) -and ($r.Output -match '(?ms)(# Review.*)')) {
    $reviewText = $matches[1].Trim()
    Set-Content -LiteralPath $reviewPath -Value $reviewText -Encoding UTF8
  }
  $reviewStatus = Parse-FinalStatus ($r.Output + "`n" + $reviewText)
  if (-not (Test-Path -LiteralPath $reviewPath) -or -not $reviewStatus) {
    Set-StageState "reviewer" "failed"
    Stop-Blocked "Reviewer produced no artifact or FINAL_STATUS (PIPELINE_ERROR)."
    Show-Status
    exit 1
  }
  if ($reviewStatus -eq "APPROVED") {
    Set-StageState "reviewer" "completed"
    $wf3 = Read-JsonFile $WorkflowFile
    $wf3.status = "APPROVED"
    $wf3.lastResult = "APPROVED"
    $wf3.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    Write-JsonFile $WorkflowFile $wf3
  } elseif ($reviewStatus -eq "CHANGES_REQUIRED") {
    Set-StageState "reviewer" "changes_required"
    Stop-Blocked "Reviewer requested CHANGES_REQUIRED. See 05-review.md Required Changes. Re-run pipeline after addressing them (or resume)."
    Show-Status
    exit 1
  } else {
    Set-StageState "reviewer" "failed"
    Stop-Blocked ("Reviewer returned '{0}'. See 05-review.md." -f $reviewStatus)
    Show-Status
    exit 1
  }
}

Write-Host ""
Write-Host "========================================"
Write-Host "PIPELINE COMPLETE"
Write-Host "========================================"
Write-Host ""
Write-Host "Reviewer: APPROVED"
Write-Host ""
Write-Host "Changes are ready for human inspection."
Write-Host ""
Write-Host "Run:"
Write-Host ""
Write-Host "  git status"
Write-Host "  git diff --stat"
Write-Host ""
Write-Host "The pipeline never commits, pushes, or merges -- you decide."
Stop-Complete "APPROVED -- awaiting human commit/merge/push."
Show-Status
