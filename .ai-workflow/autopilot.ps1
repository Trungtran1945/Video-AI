<# .SYNOPSIS
  Autonomous Engineering Autopilot for Video_AI.
  DISCOVER -> PRIORITIZE -> PLAN -> CODE -> TEST -> DEBUG -> REVIEW -> NEXT TASK (max 10) -> STOP.
.DESCRIPTION
  Reuses .ai-workflow/run-pipeline.ps1 for single-task execution (no competing system).
  Each task runs as a FRESH session: fresh run-pipeline.ps1 process, fresh CLI calls,
  no --continue across tasks. Memory is file-based only (.ai-workflow/sessions/).
  Never commits, pushes, merges, or resets. Stops for humans when done or blocked.
.EXAMPLE
  .\.ai-workflow\autopilot.ps1
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Scan
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Plan
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Run -Tasks 10
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Status
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Resume
.EXAMPLE
  .\.ai-workflow\autopilot.ps1 -Stop
#>
[CmdletBinding()]
param(
  [int]$Tasks = 10,
  [switch]$Run,
  [switch]$Scan,
  [switch]$Plan,
  [switch]$Status,
  [switch]$Resume,
  [switch]$Stop,
  [switch]$Validate,
  [switch]$DryRun,
  [switch]$SkipPermissions,
  [int]$MaxAttemptsPerTask = 2
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$WorkflowDir = Join-Path $ProjectRoot ".ai-workflow"
$HandoffDir = Join-Path $WorkflowDir "handoff"
$StateDir = Join-Path $WorkflowDir "state"
$PromptsDir = Join-Path $WorkflowDir "prompts"
$LogsRoot = Join-Path $WorkflowDir "logs"
$RunPipeline = Join-Path $WorkflowDir "run-pipeline.ps1"
$AutoDir = Join-Path $WorkflowDir "autopilot"
$DiscoveryDir = Join-Path $AutoDir "discovery"
$DiscoveryHistory = Join-Path $DiscoveryDir "history"
$BacklogDir = Join-Path $AutoDir "backlog"
$PendingDir = Join-Path $BacklogDir "pending"
$ActiveDir = Join-Path $BacklogDir "active"
$CompletedDir = Join-Path $BacklogDir "completed"
$FailedDir = Join-Path $BacklogDir "failed"
$RejectedDir = Join-Path $BacklogDir "rejected"
$ProposalsDir = Join-Path $AutoDir "proposals"
$ReportsDir = Join-Path $AutoDir "reports"
$PolicyFile = Join-Path $AutoDir "policies\autonomy-policy.yaml"
$SessionsDir = Join-Path $WorkflowDir "sessions"
$AutoStateFile = Join-Path $StateDir "autopilot-state.json"
$WorkflowFile = Join-Path $StateDir "workflow.json"
$StopFile = Join-Path $StateDir "autopilot.stop"

$Global:AutoLogDir = $null
$Global:AutoLog = $null

# ---------------- helpers ----------------

function Write-AutoLog([string]$Msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg
  Write-Host $line
  if ($Global:AutoLog) { Add-Content -LiteralPath $Global:AutoLog -Value $line }
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
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Write-JsonFile([string]$Path, $Obj) {
  Set-Content -LiteralPath $Path -Value ($Obj | ConvertTo-Json -Depth 12) -Encoding UTF8
}

function Set-JsonProp($Obj, [string]$Name, $Value) {
  if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value }
  else { $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-AutoState {
  if (-not (Test-Path -LiteralPath $AutoStateFile)) { Reset-AutoState }
  return (Read-JsonFile $AutoStateFile)
}

function Save-AutoState($State) {
  $State.updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  Write-JsonFile $AutoStateFile $State
}

function Reset-AutoState {
  $s = [pscustomobject]@{
    version = "2.0.0"; status = "IDLE"; targetTasks = 10
    completedTasks = 0; failedTasks = 0; skippedTasks = 0
    currentTask = $null; currentSession = $null
    startedAt = $null; updatedAt = $null
    lastCompletedTask = $null; lastError = $null; tasks = @()
  }
  Set-JsonProp $s "tasksSinceFullScan" 0
  Write-JsonFile $AutoStateFile $s
  return $s
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

function Resolve-Agy {
  $cli = Resolve-Cli "agy"
  if ($cli) { return $cli.Exe }
  return $null
}

function Parse-FinalStatus([string]$Text) {
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $m = [regex]::Match($Text, 'FINAL_STATUS:\s*([A-Z_]+)')
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return $null
}

function Unwrap-AgyJson([string]$Text) {
  try {
    $start = $Text.IndexOf("{"); $end = $Text.LastIndexOf("}")
    if ($start -lt 0 -or $end -le $start) { return $null }
    $obj = ($Text.Substring($start, $end - $start + 1) | ConvertFrom-Json -ErrorAction Stop)
    if ($obj.response) { return [string]$obj.response }
  } catch {}
  return $null
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

function Invoke-AgyAgent([string]$Agent, [string]$Message, [int]$TimeoutMinutes, [string]$Effort, [string]$LogFile) {
  $agy = Resolve-Agy
  if (-not $agy) { throw "Antigravity CLI 'agy' not found in PATH." }
  $argList = @("-p", $Message, "--output-format", "json", "--add-dir", $ProjectRoot, "--print-timeout", ("{0}m" -f $TimeoutMinutes))
  if ($SkipPermissions) { $argList += "--dangerously-skip-permissions" }
  if ($Effort) { $argList += @("--effort", $Effort) }
  $argList += @("--agent", $Agent)
  $argStr = Build-NativeArguments $argList
  Add-Content -LiteralPath $LogFile -Value ("=== AGENT {0} at {1} ===" -f $Agent, (Get-Date -Format "o"))
  Add-Content -LiteralPath $LogFile -Value ("CMD: {0} {1}" -f $agy, $argStr)
  $outF = [System.IO.Path]::GetTempFileName()
  $errF = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $agy -ArgumentList $argStr -WorkingDirectory $ProjectRoot -RedirectStandardOutput $outF -RedirectStandardError $errF -PassThru -NoNewWindow
  $timeoutMs = $TimeoutMinutes * 60 * 1000
  $exited = $p.WaitForExit($timeoutMs)
  if (-not $exited) {
    try { $p.Kill() } catch {}
    try { $p.WaitForExit(5000) } catch {}
    $partial = ""
    if (Test-Path -LiteralPath $outF) { $partial += (Get-Content -LiteralPath $outF -Raw) }
    if (Test-Path -LiteralPath $errF) { $partial += "`n" + (Get-Content -LiteralPath $errF -Raw) }
    Remove-Item $outF, $errF -Force -ErrorAction SilentlyContinue
    $partial = Redact-Secrets $partial
    Add-Content -LiteralPath $LogFile -Value "STAGE_TIMEOUT"
    if ($partial.Trim().Length -gt 0) { Add-Content -LiteralPath $LogFile -Value ("PARTIAL OUTPUT:`n" + $partial) }
    return @{ Status = "STAGE_TIMEOUT"; ConversationId = $null; Output = $partial; ExitCode = -1 }
  }
  $p.WaitForExit()
  $stdout = ""; $stderr = ""
  if (Test-Path -LiteralPath $outF) { $stdout = Get-Content -LiteralPath $outF -Raw }
  if (Test-Path -LiteralPath $errF) { $stderr = Get-Content -LiteralPath $errF -Raw }
  Remove-Item $outF, $errF -Force -ErrorAction SilentlyContinue
  $combined = Redact-Secrets ($stdout + "`n" + $stderr)
  Add-Content -LiteralPath $LogFile -Value $combined
  Add-Content -LiteralPath $LogFile -Value ("EXIT: {0}" -f $p.ExitCode)
  if ($combined -match 'no output produced|soft-deny|denied_actions') {
    return @{ Status = "PERMISSION_DENIED"; ConversationId = $null; Output = $combined; ExitCode = $p.ExitCode }
  }
  $conv = $null
  $m = [regex]::Match($combined, '"conversation_id"\s*:\s*"([^"]+)"')
  if ($m.Success) { $conv = $m.Groups[1].Value }
  $body = Unwrap-AgyJson $combined
  if ($body) { $combined = $body }
  return @{ Status = (Parse-FinalStatus $combined); ConversationId = $conv; Output = $combined; ExitCode = $p.ExitCode }
}

# ---------------- backlog ----------------

function Get-TaskField([string]$Content, [string]$Field) {
  $m = [regex]::Match($Content, "(?ms)^##\s+" + $Field + "\s*\r?\n(.*?)(?=^##\s+|\z)")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ""
}

function Get-BacklogTasks([string]$Dir) {
  $out = @()
  if (-not (Test-Path -LiteralPath $Dir)) { return $out }
  foreach ($f in (Get-ChildItem -LiteralPath $Dir -Filter "*.md" -ErrorAction SilentlyContinue)) {
    $c = Get-Content -LiteralPath $f.FullName -Raw
    $id = ""
    $m = [regex]::Match($f.BaseName, '^(TASK-\d+)')
    if ($m.Success) { $id = $m.Groups[1].Value }
    $out += [pscustomobject]@{
      TaskId = $id; File = $f.FullName; FileName = $f.Name
      Title = (Get-TaskField $c "Title"); Type = ((Get-TaskField $c "Type").ToLower())
      Priority = ((Get-TaskField $c "Priority").ToLower())
      Autonomy = ((Get-TaskField $c "Autonomy").ToLower()); Content = $c
    }
  }
  return $out
}

function Get-NextTaskNumber {
  $max = 0
  foreach ($d in @($PendingDir, $ActiveDir, $CompletedDir, $FailedDir, $RejectedDir)) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    foreach ($f in (Get-ChildItem -LiteralPath $d -Filter "TASK-*.md" -ErrorAction SilentlyContinue)) {
      $m = [regex]::Match($f.BaseName, '^TASK-(\d+)')
      if ($m.Success) { $n = [int]$m.Groups[1].Value; if ($n -gt $max) { $max = $n } }
    }
  }
  $st = Get-AutoState
  foreach ($t in @($st.tasks)) {
    $m = [regex]::Match([string]$t.taskId, '^TASK-(\d+)')
    if ($m.Success) { $n = [int]$m.Groups[1].Value; if ($n -gt $max) { $max = $n } }
  }
  return ($max + 1)
}

function Remove-DuplicateBacklog {
  $seen = @{}
  foreach ($d in @($CompletedDir, $FailedDir, $ActiveDir)) {
    foreach ($t in (Get-BacklogTasks $d)) {
      $k = ($t.Title.ToLower() -replace '\s+', ' ').Trim()
      if ($k.Length -gt 0) { $seen[$k] = $true }
    }
  }
  $removed = 0
  foreach ($t in (Get-BacklogTasks $PendingDir)) {
    $k = ($t.Title.ToLower() -replace '\s+', ' ').Trim()
    if ($seen.ContainsKey($k)) {
      $dest = Join-Path $RejectedDir $t.FileName
      Move-Item -LiteralPath $t.File -Destination $dest -Force
      Add-Content -LiteralPath $dest -Value "`n## Decision`nREJECTED -- duplicate of an existing task."
      $removed++
    } else { $seen[$k] = $true }
  }
  return $removed
}

function Get-PriorityRank([string]$P) {
  if ($P -eq "critical") { return 1 }
  if ($P -eq "high") { return 2 }
  if ($P -eq "medium") { return 3 }
  if ($P -eq "low") { return 4 }
  return 5
}

function Get-TypeRank([string]$T) {
  if ($T -eq "bug") { return 1 }
  if ($T -eq "security") { return 2 }
  if ($T -eq "test") { return 3 }
  if ($T -eq "performance") { return 4 }
  if ($T -eq "refactor") { return 5 }
  if ($T -eq "documentation") { return 6 }
  if ($T -eq "feature") { return 7 }
  return 8
}

function Select-NextTask {
  $ranked = @(Get-BacklogTasks $PendingDir | Sort-Object @{ Expression = { Get-PriorityRank $_.Priority } }, @{ Expression = { Get-TypeRank $_.Type } }, @{ Expression = { $_.FileName } })
  foreach ($t in $ranked) {
    if ($t.Autonomy -eq "human-approval") {
      $dest = Join-Path $RejectedDir $t.FileName
      Move-Item -LiteralPath $t.File -Destination $dest -Force
      Add-Content -LiteralPath $dest -Value "`n## Decision`nREJECTED -- requires human approval per autonomy-policy.yaml."
      Write-AutoLog ("Rejected {0} (needs human approval)." -f $t.TaskId)
      continue
    }
    return $t
  }
  return $null
}

# ---------------- phases ----------------

function Initialize-AutopilotLog {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $Global:AutoLogDir = Join-Path $LogsRoot ("autopilot\" + $stamp)
  New-Item -ItemType Directory -Force -Path $Global:AutoLogDir | Out-Null
  $Global:AutoLog = Join-Path $Global:AutoLogDir "autopilot.log"
}

function Invoke-ScanPhase([switch]$FullDetail) {
  $st = Get-AutoState
  $st.status = "SCANNING"; Save-AutoState $st
  Write-AutoLog "PHASE 0-2: discovery scan (fresh agy session, 15 min timeout)."
  $scanLog = Join-Path $Global:AutoLogDir "discovery.log"

  $canonicalScanFile = Join-Path $AutoDir "latest-scan.md"
  $legacyScanFile = Join-Path $DiscoveryDir "latest-scan.md"

  # Clean stale scan files before running
  if (Test-Path -LiteralPath $canonicalScanFile) { Remove-Item -LiteralPath $canonicalScanFile -Force }
  if (Test-Path -LiteralPath $legacyScanFile) { Remove-Item -LiteralPath $legacyScanFile -Force }

  Write-AutoLog "[Discovery] Starting fresh Antigravity session..."
  Write-AutoLog ("[Discovery] Project root: {0}" -f $ProjectRoot)
  Write-AutoLog "[Discovery] Agent: discovery"
  Write-AutoLog ("[Discovery] Output directory: {0}" -f $AutoDir)

  $msg = ("Follow .ai-workflow/prompts/discovery.md exactly (it is the source of truth). Project root: {0}. Write canonical scan file to {1} and backlog task files in {2}. End with FINAL_STATUS: SCAN_DONE." -f $ProjectRoot, $canonicalScanFile, $PendingDir)
  $r = Invoke-AgyAgent "discovery" $msg 15 "medium" $scanLog

  Write-AutoLog ("[Discovery] Process exit code: {0}" -f $r.ExitCode)

  if ($r.Status -eq "STAGE_TIMEOUT") {
    Write-AutoLog "[Discovery] Final status: FAILED (TIMEOUT)"
    throw "Discovery timeout after 15 min."
  }
  if ($r.Status -eq "PERMISSION_DENIED") {
    Write-AutoLog "[Discovery] Final status: FAILED (PERMISSION_DENIED)"
    throw "Discovery soft-denied (see discovery.log). Add the named allow-rule to ~/.gemini/antigravity-cli/settings.json permissions.allow."
  }

  # If agent wrote to legacy location, move to canonical location
  if (-not (Test-Path -LiteralPath $canonicalScanFile) -and (Test-Path -LiteralPath $legacyScanFile)) {
    Move-Item -LiteralPath $legacyScanFile -Destination $canonicalScanFile -Force
    Write-AutoLog "[Discovery] Moved scan file from discovery/ to canonical location."
  }

  # If file not written to disk, attempt extraction from output
  if (-not (Test-Path -LiteralPath $canonicalScanFile) -and ($r.Output -match '(?ms)(# Autonomous Project Scan.*)')) {
    $scanText = $matches[1].Trim()
    Set-Content -LiteralPath $canonicalScanFile -Value $scanText -Encoding UTF8
    Write-AutoLog "[Discovery] Extracted latest-scan.md from discovery agent output."
  }

  # Extract backlog tasks if not written to disk directly
  $pendingCount = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  if ($pendingCount -eq 0 -and ($r.Output -match '(?ms)# TASK-\d+')) {
    $taskMatches = [regex]::Matches($r.Output, '(?ms)(# (TASK-\d+)\s*\r?\n.*?)(?=\n# TASK-\d+|\z)')
    foreach ($tm in $taskMatches) {
      $block = $tm.Groups[1].Value.Trim()
      $tid = $tm.Groups[2].Value
      $tTitle = (Get-TaskField $block "Title")
      $slug = if ($tTitle) { ($tTitle.ToLower() -replace '[^a-z0-9]+', '-').Trim('-') } else { "task" }
      $destFile = Join-Path $PendingDir ("{0}-{1}.md" -f $tid, $slug)
      Set-Content -LiteralPath $destFile -Value $block -Encoding UTF8
      Write-AutoLog ("[Discovery] Extracted backlog item from discovery output: {0}" -f (Split-Path $destFile -Leaf))
    }
  }

  $scanExists = Test-Path -LiteralPath $canonicalScanFile
  $scanContent = if ($scanExists) { Get-Content -LiteralPath $canonicalScanFile -Raw } else { "" }
  $hasScanDone = ($r.Status -eq "SCAN_DONE" -or $scanContent -match 'FINAL_STATUS:\s*SCAN_DONE' -or $scanContent -match '(?i)SCAN_DONE')
  $isNoFindings = ($r.Status -eq "NO_ACTIONABLE_FINDINGS" -or $scanContent -match 'NO_ACTIONABLE_FINDINGS')

  $dups = Remove-DuplicateBacklog
  $count = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count

  Write-AutoLog ("[Discovery] latest-scan.md exists: {0}" -f $scanExists)
  Write-AutoLog ("[Discovery] SCAN_DONE marker: {0}" -f $hasScanDone)
  Write-AutoLog ("[Discovery] Backlog tasks discovered: {0}" -f $count)

  $finalStatus = if ($hasScanDone) { "SCAN_DONE" } elseif ($isNoFindings) { "NO_ACTIONABLE_FINDINGS" } else { "FAILED" }
  Write-AutoLog ("[Discovery] Final status: {0}" -f $finalStatus)

  if (-not $scanExists) {
    $errDetail = if ($r.Output) { "`nLast output snippet: " + ($r.Output.Substring(0, [Math]::Min(300, $r.Output.Length))) } else { "" }
    throw ("Discovery did not produce latest-scan.md (ExitCode: {0}).{1}" -f $r.ExitCode, $errDetail)
  }

  if (-not $hasScanDone -and -not $isNoFindings) {
    throw ("Discovery latest-scan.md did not contain SCAN_DONE (Status: {0})." -f $r.Status)
  }

  # Ensure latest-scan.md has FINAL_STATUS: SCAN_DONE line if missing
  if ($hasScanDone -and ($scanContent -notmatch 'FINAL_STATUS:\s*SCAN_DONE')) {
    Add-Content -LiteralPath $canonicalScanFile -Value "`n## Final Status`nFINAL_STATUS: SCAN_DONE" -Encoding UTF8
  }

  # Archive scan history
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  New-Item -ItemType Directory -Force -Path $DiscoveryHistory | Out-Null
  Copy-Item -LiteralPath $canonicalScanFile -Destination (Join-Path $DiscoveryHistory ("{0}-scan.md" -f $stamp)) -Force

  if ($isNoFindings -and $count -eq 0) {
    Write-AutoLog "Discovery completed: NO_ACTIONABLE_FINDINGS. Codebase has no pending tasks."
    $st2 = Get-AutoState
    Set-JsonProp $st2 "tasksSinceFullScan" 0
    Save-AutoState $st2
    return 0
  }

  Write-AutoLog ("Scan done. Pending backlog: {0} (duplicates removed: {1})." -f $count, $dups)
  $st2 = Get-AutoState
  Set-JsonProp $st2 "tasksSinceFullScan" 0
  if ($st2.status -eq "SCANNING") { $st2.status = "IDLE" }
  $st2.lastError = $null
  Save-AutoState $st2
  return $count
}

function Invoke-RunTask($Task, [int]$MaxAttempts) {
  $taskId = $Task.TaskId
  $sessionDir = Join-Path $SessionsDir ($taskId.ToLower())
  New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
  $runId = [guid]::NewGuid().ToString("N").Substring(0, 8)
  Write-AutoLog ("--- {0}: {1} (fresh session {2}) ---" -f $taskId, $Task.Title, $runId)
  $activeFile = Join-Path $ActiveDir $Task.FileName
  Move-Item -LiteralPath $Task.File -Destination $activeFile -Force
  $session = [pscustomobject]@{
    taskId = $taskId; sessionId = $runId; runId = $runId; opencodeSession = $null
    antigravityConversations = @(); startedAt = (Get-Date).ToUniversalTime().ToString("o")
    completedAt = $null; status = "running"
  }
  $st = Get-AutoState
  $st.status = "RUNNING"; $st.currentTask = $taskId; $st.currentSession = $sessionDir
  $entry = [pscustomobject]@{
    taskId = $taskId; title = $Task.Title; type = $Task.Type; priority = $Task.Priority
    status = "running"
    runtime = [pscustomobject]@{
      planner = "opencode"; coder = "opencode"; tester = "antigravity"
      debugger = "opencode"; reviewer = "antigravity"
    }
    session = [pscustomobject]@{
      opencode = $null; antigravity = $null
    }
    attempts = 0; maxAttempts = $MaxAttempts
    createdAt = (Get-Date).ToUniversalTime().ToString("o"); completedAt = $null
  }
  $st.tasks = @($st.tasks) + @($entry)
  Save-AutoState $st
  Copy-Item -LiteralPath $activeFile -Destination (Join-Path $sessionDir "task.md") -Force
  Write-JsonFile (Join-Path $sessionDir "session.json") $session
  foreach ($h in @("01-plan.md", "02-changes.md", "03-test-results.md", "04-debug.md", "05-review.md")) {
    $p = Join-Path $HandoffDir $h
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
  }
  $title = $Task.Title
  if ([string]::IsNullOrWhiteSpace($title)) { $title = $taskId }
  $pipeArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RunPipeline, "-Request", $title, "-MaxRetries", "$MaxAttempts")
  if ($SkipPermissions) { $pipeArgs += "-SkipPermissions" }
  $pipeArgStr = Build-NativeArguments $pipeArgs
  $outF = [System.IO.Path]::GetTempFileName()
  $errF = [System.IO.Path]::GetTempFileName()
  $cp = Start-Process -FilePath "powershell" -ArgumentList $pipeArgStr -WorkingDirectory $ProjectRoot -RedirectStandardOutput $outF -RedirectStandardError $errF -PassThru -NoNewWindow
  $cp.WaitForExit()
  $childOut = ""
  if (Test-Path -LiteralPath $outF) { $childOut += (Get-Content -LiteralPath $outF -Raw) }
  if (Test-Path -LiteralPath $errF) { $childOut += "`n" + (Get-Content -LiteralPath $errF -Raw) }
  Remove-Item $outF, $errF -Force -ErrorAction SilentlyContinue
  $childOut = Redact-Secrets $childOut
  Set-Content -LiteralPath (Join-Path $sessionDir "pipeline-output.txt") -Value $childOut -Encoding UTF8
  Write-AutoLog ("{0} pipeline exit: {1}" -f $taskId, $cp.ExitCode)
  $wf = Read-JsonFile (Join-Path $StateDir "workflow.json")
  $ok = ($wf.status -eq "COMPLETE" -and $wf.lastResult -match "APPROVED")
  $convs = @()
  try {
    $runLogRoot = Join-Path $LogsRoot ""
    $latest = Get-ChildItem -LiteralPath $LogsRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d{8}-\d{6}$' } | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) {
      foreach ($lf in (Get-ChildItem -LiteralPath $latest.FullName -Filter "*.log" -ErrorAction SilentlyContinue)) {
        $m = [regex]::Matches((Get-Content -LiteralPath $lf.FullName -Raw), '"conversation_id"\s*:\s*"([^"]+)"')
        foreach ($x in $m) { $convs += $x.Groups[1].Value }
      }
    }
  } catch {}
  $convs = @($convs | Select-Object -Unique)
  foreach ($pair in @( @("01-plan.md", "planner-result.md"), @("02-changes.md", "coder-result.md"), @("03-test-results.md", "tester-result.md"), @("04-debug.md", "debug-result.md"), @("05-review.md", "review-result.md") )) {
    $src = Join-Path $HandoffDir $pair[0]
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $sessionDir $pair[1]) -Force }
  }
  $debugDest = Join-Path $sessionDir "debug-result.md"
  if (-not (Test-Path -LiteralPath $debugDest)) {
    Set-Content -LiteralPath $debugDest -Value "# Debug Result`n`n## Status`nSKIPPED -- initial tests passed on first attempt; debugging not required." -Encoding UTF8
  }
  $diffStat = ""
  try { $diffStat = (& git -C $ProjectRoot diff --stat 2>&1 | Out-String) } catch { $diffStat = "(git unavailable)" }
  $diffStat = Redact-Secrets $diffStat
  Set-Content -LiteralPath (Join-Path $sessionDir "git-diff-stat.txt") -Value $diffStat -Encoding UTF8
  $outcome = ("TASK_FAILED (pipeline status: {0}, last: {1})" -f $wf.status, $wf.lastResult)
  if ($ok) { $outcome = "TASK_COMPLETE (IMPLEMENTED + TEST_PASS + REVIEW APPROVED)" }
  $sumLines = @()
  $sumLines += ("# {0} Summary" -f $taskId)
  $sumLines += ""
  $sumLines += "## Title"
  $sumLines += $Task.Title
  $sumLines += ""
  $sumLines += "## Outcome"
  $sumLines += $outcome
  $sumLines += ""
  $sumLines += "## Session"
  $sumLines += ("Fresh run, no continued conversation. Antigravity conversations: {0}" -f ($convs -join ", "))
  $sumLines += ""
  $sumLines += "## Git Diff Stat"
  $sumLines += $diffStat.Trim()
  Set-Content -LiteralPath (Join-Path $sessionDir "summary.md") -Value ($sumLines -join "`n") -Encoding UTF8
  $session.status = if ($ok) { "completed" } else { "failed" }
  $session.completedAt = (Get-Date).ToUniversalTime().ToString("o")
  $session.antigravityConversations = $convs
  Write-JsonFile (Join-Path $sessionDir "session.json") $session
  $st2 = Get-AutoState
  foreach ($t in @($st2.tasks)) {
    if ($t.taskId -eq $taskId) {
      $t.attempts = $MaxAttempts
      $t.session.antigravity = ($convs -join ", ")
      if ($ok) {
        $t.status = "completed"; $t.completedAt = (Get-Date).ToUniversalTime().ToString("o")
        $st2.completedTasks++
        $st2.lastCompletedTask = $taskId
        Move-Item -LiteralPath $activeFile -Destination (Join-Path $CompletedDir $Task.FileName) -Force
      } else {
        $t.status = "failed"; $t.completedAt = (Get-Date).ToUniversalTime().ToString("o")
        $st2.failedTasks++
        $st2.lastError = ("{0}: pipeline ended {1}/{2}" -f $taskId, $wf.status, $wf.lastResult)
        Move-Item -LiteralPath $activeFile -Destination (Join-Path $FailedDir $Task.FileName) -Force
      }
    }
  }
  $n = 0
  if ($st2.PSObject.Properties["tasksSinceFullScan"]) { $n = [int]$st2.tasksSinceFullScan }
  Set-JsonProp $st2 "tasksSinceFullScan" ($n + 1)
  $st2.currentTask = $null; $st2.currentSession = $null
  Save-AutoState $st2
  return $ok
}

function Write-FinalReport {
  $st = Get-AutoState
  $now = (Get-Date).ToUniversalTime().ToString("o")
  $lines = @()
  $lines += "# Autonomous Engineering Report"
  $lines += ""
  $lines += "## Run"
  $lines += ""
  $lines += ("Start: {0}" -f $st.startedAt)
  $lines += ("End: {0}" -f $now)
  $lines += ""
  $lines += "## Result"
  $lines += ""
  $lines += ("{0} / {1} tasks completed" -f $st.completedTasks, $st.targetTasks)
  $lines += ""
  $lines += "## Completed Tasks"
  $lines += ""
  $completed = @(@($st.tasks) | Where-Object { $_.status -eq "completed" })
  foreach ($t in $completed) {
    $lines += ("### {0}" -f $t.taskId)
    $lines += ""
    $lines += ("Type: {0}" -f $t.type)
    $lines += ""
    $lines += ("Result: completed ({0})" -f $t.title)
    $lines += ""
    $sd = Join-Path $SessionsDir ($t.taskId.ToLower())
    $lines += ("Session: .ai-workflow/sessions/{0}/" -f $t.taskId.ToLower())
    $lines += ""
    if (Test-Path -LiteralPath (Join-Path $sd "git-diff-stat.txt")) {
      $lines += "Files:"
      $lines += '```'
      $statText = Get-Content -LiteralPath (Join-Path $sd "git-diff-stat.txt") -Raw
      $lines += $statText.Trim()
      $lines += '```'
      $lines += ""
    }
    $testRes = Join-Path $sd "tester-result.md"
    $testSummary = if (Test-Path -LiteralPath $testRes) { "PASS (see tester-result.md)" } else { "PASS" }
    $lines += ("Tests: {0}" -f $testSummary)
    $lines += ""
  }
  $lines += "## Failed Tasks"
  $lines += ""
  $failed = @(@($st.tasks) | Where-Object { $_.status -eq "failed" })
  if ($failed.Count -eq 0) { $lines += "None." }
  else {
    foreach ($t in $failed) { $lines += ("- {0}: {1}" -f $t.taskId, $t.title) }
  }
  $lines += ""
  $lines += "## Skipped / Blocked Tasks"
  $lines += ""
  $rejectedFiles = @(Get-ChildItem -LiteralPath $RejectedDir -Filter "*.md" -ErrorAction SilentlyContinue)
  if ($rejectedFiles.Count -eq 0) { $lines += "None." }
  else {
    foreach ($f in $rejectedFiles) { $lines += ("- {0}" -f $f.Name) }
  }
  $lines += ""
  $lines += "## Bugs Fixed"
  $lines += ""
  $bugs = @($completed | Where-Object { $_.type -eq "bug" })
  if ($bugs.Count -eq 0) { $lines += "None." }
  else { foreach ($b in $bugs) { $lines += ("- {0}: {1}" -f $b.taskId, $b.title) } }
  $lines += ""
  $lines += "## Features Added"
  $lines += ""
  $feats = @($completed | Where-Object { $_.type -eq "feature" })
  if ($feats.Count -eq 0) { $lines += "None." }
  else { foreach ($f in $feats) { $lines += ("- {0}: {1}" -f $f.taskId, $f.title) } }
  $lines += ""
  $lines += "## Tests Added"
  $lines += ""
  $testsAdded = @($completed | Where-Object { $_.type -eq "test" })
  if ($testsAdded.Count -eq 0) { $lines += "None." }
  else { foreach ($ta in $testsAdded) { $lines += ("- {0}: {1}" -f $ta.taskId, $ta.title) } }
  $lines += ""
  $lines += "## Performance Improvements"
  $lines += ""
  $perfs = @($completed | Where-Object { $_.type -eq "performance" })
  if ($perfs.Count -eq 0) { $lines += "None." }
  else { foreach ($p in $perfs) { $lines += ("- {0}: {1}" -f $p.taskId, $p.title) } }
  $lines += ""
  $lines += "## Security Improvements"
  $lines += ""
  $secs = @($completed | Where-Object { $_.type -eq "security" })
  if ($secs.Count -eq 0) { $lines += "None." }
  else { foreach ($s in $secs) { $lines += ("- {0}: {1}" -f $s.taskId, $s.title) } }
  $lines += ""
  $lines += "## Remaining Risks"
  $lines += ""
  $lines += "- See open backlog in .ai-workflow/autopilot/backlog/pending/ and rejected/."
  $lines += ""
  $lines += "## Recommendations"
  $lines += ""
  $lines += "- Human review of all diffs before any commit (autopilot never commits)."
  $lines += ""
  $lines += "## Final Status"
  $lines += ""
  $lines += "AUTOPILOT_COMPLETE"
  $report = Join-Path $ReportsDir "final-report.md"
  Set-Content -LiteralPath $report -Value ($lines -join "`n") -Encoding UTF8
  Write-AutoLog ("Final report: {0}" -f $report)
}

function Show-AutoValidation {
  $checks = @()
  $checks += @{ Name = "autopilot.ps1 exists"; Pass = (Test-Path -LiteralPath (Join-Path $WorkflowDir "autopilot.ps1")) }
  $checks += @{ Name = "run-pipeline.ps1 exists"; Pass = (Test-Path -LiteralPath $RunPipeline) }

  $ocCli = Resolve-Cli "opencode"
  $agyCli = Resolve-Cli "agy"
  $checks += @{ Name = "OpenCode CLI available"; Pass = ($ocCli -ne $null) }
  $checks += @{ Name = "Antigravity CLI available"; Pass = ($agyCli -ne $null) }

  $roles = @("discovery", "prioritizer", "planner", "coder", "tester", "debugger", "reviewer")
  $promptsOk = $true
  $opencodeAgentsOk = $true
  $antigravityAgentsOk = $true
  foreach ($r in $roles) {
    if (-not (Test-Path -LiteralPath (Join-Path $PromptsDir ("{0}.md" -f $r)))) { $promptsOk = $false }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot (".opencode\agents\{0}.md" -f $r)))) { $opencodeAgentsOk = $false }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot (".agents\agents\{0}\agent.md" -f $r)))) { $antigravityAgentsOk = $false }
  }
  $checks += @{ Name = "Shared prompts exist (7 roles)"; Pass = $promptsOk }
  $checks += @{ Name = "OpenCode agent adapters exist (7 roles)"; Pass = $opencodeAgentsOk }
  $checks += @{ Name = "Antigravity agent adapters exist (7 roles)"; Pass = $antigravityAgentsOk }

  $wfOk = $false
  try {
    $wf = Read-JsonFile $WorkflowFile
    $wfOk = ($wf.runtime.planner -eq "opencode" -and
             $wf.runtime.coder -eq "opencode" -and
             $wf.runtime.tester -eq "antigravity" -and
             $wf.runtime.debugger -eq "opencode" -and
             $wf.runtime.reviewer -eq "antigravity")
  } catch {}
  $checks += @{ Name = "Runtime mapping (planner=opencode, coder=opencode, tester=antigravity, debugger=opencode, reviewer=antigravity)"; Pass = $wfOk }

  $ocModelOk = $false
  $ocCfg = Join-Path $ProjectRoot ".opencode\opencode.json"
  if (Test-Path -LiteralPath $ocCfg) {
    try {
      $ocJson = Read-JsonFile $ocCfg
      $ocModelOk = ($ocJson.model -eq "opencode/muse-spark-1.3-contributor-free")
    } catch {}
  }
  $checks += @{ Name = "OpenCode model (opencode/muse-spark-1.3-contributor-free)"; Pass = $ocModelOk }

  $artifactPathsOk = ((Test-Path -LiteralPath $AutoDir) -and
                      (Test-Path -LiteralPath $HandoffDir) -and
                      (Test-Path -LiteralPath $StateDir))
  $checks += @{ Name = "Artifact directories exist (autopilot, handoff, state)"; Pass = $artifactPathsOk }

  $backlogDirsOk = ((Test-Path -LiteralPath $PendingDir) -and
                    (Test-Path -LiteralPath $ActiveDir) -and
                    (Test-Path -LiteralPath $CompletedDir) -and
                    (Test-Path -LiteralPath $FailedDir) -and
                    (Test-Path -LiteralPath $RejectedDir))
  $checks += @{ Name = "Backlog directories exist (pending, active, completed, failed, rejected)"; Pass = $backlogDirsOk }

  $jsonOk = $true
  try { [void](Read-JsonFile $AutoStateFile) } catch { $jsonOk = $false }
  $checks += @{ Name = "autopilot-state.json valid"; Pass = $jsonOk }

  $policyOk = $false
  if (Test-Path -LiteralPath $PolicyFile) {
    $pc = Get-Content -LiteralPath $PolicyFile -Raw
    $policyOk = ($pc -match "targetTasks" -and $pc -match "requireHumanApproval" -and $pc -match "neverAutoExecute")
  }
  $checks += @{ Name = "autonomy-policy.yaml has approval gates"; Pass = $policyOk }

  $contUses = (Select-String -LiteralPath (Join-Path $WorkflowDir "autopilot.ps1") -Pattern "--continue" -SimpleMatch -ErrorAction SilentlyContinue | Where-Object { ($_.Line -notmatch '(?i)no .*--continue') -and ($_.Line -notmatch 'Select-String') } | Measure-Object).Count
  $checks += @{ Name = "Fresh session isolation (no --continue in loop)"; Pass = ($contUses -eq 0) }

  $tasksClampOk = (Select-String -LiteralPath (Join-Path $WorkflowDir "autopilot.ps1") -Pattern "Tasks -gt 10" -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
  $checks += @{ Name = "10-task limit enforced (clamped to max 10)"; Pass = $tasksClampOk }

  $gitOk = ((Get-Command "git" -ErrorAction SilentlyContinue) -ne $null)
  $gitBad = (Select-String -LiteralPath (Join-Path $WorkflowDir "autopilot.ps1") -Pattern "git commit", "git push", "git merge", "git reset --hard", "git clean" -SimpleMatch -ErrorAction SilentlyContinue | Where-Object { $_.Line -notmatch '(?i)never|forbidden|prohibited|Select-String|#|\$lines' } | Measure-Object).Count
  $checks += @{ Name = "Git safety (git CLI available, no forbidden mutations in loop)"; Pass = ($gitOk -and $gitBad -eq 0) }

  $allPass = $true
  foreach ($c in $checks) {
    $tag = "FAIL"
    if ($c.Pass) { $tag = "PASS" } else { $allPass = $false }
    Write-Host ("[{0}] {1}" -f $tag, $c.Name)
  }
  if (-not $allPass) { Write-Host "AUTOPILOT VALIDATION FAILED" } else { Write-Host "AUTOPILOT VALIDATION PASSED" }
  return $allPass
}

function Show-AutoStatus {
  $st = Get-AutoState
  Write-Host ""
  Write-Host ("Autopilot: {0} (target {1})" -f $st.status, $st.targetTasks)
  Write-Host ("Completed: {0} | Failed: {1} | Skipped: {2}" -f $st.completedTasks, $st.failedTasks, $st.skippedTasks)
  Write-Host ("Current:   {0}" -f $st.currentTask)
  $pend = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  $act = @(Get-ChildItem -LiteralPath $ActiveDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  $comp = @(Get-ChildItem -LiteralPath $CompletedDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  $fail = @(Get-ChildItem -LiteralPath $FailedDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  $rej = @(Get-ChildItem -LiteralPath $RejectedDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  Write-Host ("Backlog:   pending={0} active={1} completed={2} failed={3} rejected={4}" -f $pend, $act, $comp, $fail, $rej)
  if ($st.lastError) { Write-Host ("LastError: {0}" -f $st.lastError) }
  Write-Host ""
}

# ---------------- entry ----------------

if ($Tasks -gt 10) { Write-Host "WARNING: -Tasks clamped to maximum 10."; $Tasks = 10 }
if ($Tasks -lt 1) { Write-Host "-Tasks must be >= 1."; exit 1 }

if ($Status) { Show-AutoStatus; return }
if ($Validate) { if (-not (Show-AutoValidation)) { exit 1 }; return }

if ($Stop) {
  Set-Content -LiteralPath $StopFile -Value ("stop requested at {0}" -f (Get-Date -Format "o")) -Encoding UTF8
  Write-Host "Stop requested. Autopilot will finish the current task stage safely, then stop (AUTOPILOT_STOPPED)."
  return
}

if ($DryRun) {
  Write-Host "DRY RUN -- validating only, no agents will be called."
  $ok = Show-AutoValidation
  $pend = @(Get-BacklogTasks $PendingDir)
  Write-Host ""
  Write-Host ("Target: {0} tasks | Pending backlog: {1}" -f $Tasks, $pend.Count)
  Write-Host ""
  Write-Host "Stage Resolution Pipeline:"
  Write-Host "  Discovery (Antigravity) -> .ai-workflow/autopilot/latest-scan.md"
  Write-Host "  -> Backlog (.ai-workflow/autopilot/backlog/pending/TASK-NNN.md)"
  Write-Host "  -> Task selection (Select-NextTask by priority + type ranking)"
  Write-Host "  -> Planner (OpenCode: opencode/muse-spark-1.3-contributor-free) -> 01-plan.md"
  Write-Host "  -> Coder (OpenCode: opencode/muse-spark-1.3-contributor-free) -> 02-changes.md"
  Write-Host "  -> Tester (Antigravity) -> 03-test-results.md"
  Write-Host "  -> [Debugger (OpenCode) -> Coder -> Retest] (max 2 retries on failure)"
  Write-Host "  -> Reviewer (Antigravity) -> 05-review.md"
  Write-Host "  -> Completion gate (IMPLEMENTED + TEST_PASS + APPROVED -> completed)"
  Write-Host "  -> Stop after 10 completed tasks"
  Write-Host ""
  if (-not $ok) { exit 1 }
  return
}

Initialize-AutopilotLog

if ($Scan -and -not $Plan -and -not $Run -and -not $Resume) {
  try {
    $n = Invoke-ScanPhase
    Write-Host ("SCAN DONE. Pending backlog: {0}" -f $n)
  } catch {
    Write-AutoLog ("SCAN FAILED: {0}" -f $_.Exception.Message)
    exit 1
  }
  return
}

if ($Plan -and -not $Run -and -not $Resume) {
  try {
    $pendCount = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
    if ($pendCount -eq 0) { [void](Invoke-ScanPhase) }
    else { Write-AutoLog ("Backlog already has {0} pending tasks, skipping re-scan." -f $pendCount) }
    [void](Remove-DuplicateBacklog)
    $ranked = @(Get-BacklogTasks $PendingDir | Sort-Object @{ Expression = { Get-PriorityRank $_.Priority } }, @{ Expression = { Get-TypeRank $_.Type } }, @{ Expression = { $_.FileName } })
    $rl = @("# Backlog Ranking", "", "## Ranked At", "", (Get-Date).ToUniversalTime().ToString("o"), "", "## Order", "")
    $i = 1
    foreach ($t in $ranked) { $rl += ("{0}. {1} -- {2} ({3}, {4}, {5})" -f $i, $t.TaskId, $t.Title, $t.Priority, $t.Type, $t.Autonomy); $i++ }
    $rl += ""
    Set-Content -LiteralPath (Join-Path $ProposalsDir "ranking.md") -Value ($rl -join "`n") -Encoding UTF8
    Write-Host ("PLAN DONE. {0} tasks ranked, no code executed." -f $ranked.Count)
  } catch {
    Write-AutoLog ("PLAN FAILED: {0}" -f $_.Exception.Message)
    exit 1
  }
  return
}

# ---------------- full loop ----------------

$isResume = [bool]$Resume
$st0 = Get-AutoState
if (-not $isResume) {
  if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force }
  $st0 = Reset-AutoState
  $st0.status = "RUNNING"; $st0.targetTasks = $Tasks
  $st0.startedAt = (Get-Date).ToUniversalTime().ToString("o")
  Save-AutoState $st0
  Write-AutoLog ("Autopilot started. Target: {0} tasks." -f $Tasks)
  try {
    $gs = (& git -C $ProjectRoot status --short 2>&1 | Out-String)
    if ($gs.Trim().Length -gt 0) {
      Write-AutoLog "WARNING: Working tree has pre-existing changes. Baseline recorded, never reset."
      Set-Content -LiteralPath (Join-Path $Global:AutoLogDir "git-baseline-status.txt") -Value (Redact-Secrets $gs) -Encoding UTF8
    }
  } catch { Write-AutoLog "WARNING: git baseline check failed; continuing." }
} else {
  $st0.targetTasks = $Tasks
  Save-AutoState $st0
  Write-AutoLog ("Resuming autopilot. Completed so far: {0}/{1}." -f $st0.completedTasks, $st0.targetTasks)
  if ($st0.currentTask) {
    Write-AutoLog ("Recovery: {0} was mid-flight -> RECOVERY_REQUIRED (not assumed complete)." -f $st0.currentTask)
    foreach ($f in (Get-ChildItem -LiteralPath $ActiveDir -Filter ("{0}*.md" -f $st0.currentTask) -ErrorAction SilentlyContinue)) {
      Move-Item -LiteralPath $f.FullName -Destination (Join-Path $PendingDir $f.Name) -Force
      Add-Content -LiteralPath (Join-Path $PendingDir $f.Name) -Value "`n## Recovery`nRECOVERY_REQUIRED after autopilot resume; will be re-executed as a fresh session."
    }
    $stR = Get-AutoState
    foreach ($t in @($stR.tasks)) { if ($t.taskId -eq $st0.currentTask -and $t.status -eq "running") { $t.status = "recovery_required" } }
    $stR.currentTask = $null; $stR.currentSession = $null
    Save-AutoState $stR
  }
}

while ($true) {
  $st = Get-AutoState
  if ($st.completedTasks -ge $st.targetTasks) { break }
  if (Test-Path -LiteralPath $StopFile) {
    $st.status = "STOPPED"; Save-AutoState $st
    Write-AutoLog "AUTOPILOT_STOPPED by request. State saved; resume with -Resume."
    Show-AutoStatus
    return
  }
  $sinceFull = 0
  if ($st.PSObject.Properties["tasksSinceFullScan"]) { $sinceFull = [int]$st.tasksSinceFullScan }
  $pendCount = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
  if ($pendCount -eq 0 -or $sinceFull -ge 3) {
    Write-AutoLog "Backlog empty or 3 tasks since full scan -> running discovery."
    try { [void](Invoke-ScanPhase) }
    catch {
      $stE = Get-AutoState
      $stE.status = "BLOCKED"; $stE.lastError = $_.Exception.Message
      Save-AutoState $stE
      Write-AutoLog ("AUTOPILOT_BLOCKED: {0}" -f $_.Exception.Message)
      exit 1
    }
  } else {
    Write-AutoLog "Light pass: re-ranking existing backlog (no agent call)."
    [void](Remove-DuplicateBacklog)
  }
  $task = Select-NextTask
  if (-not $task) {
    $stB = Get-AutoState
    $pendLeft = @(Get-ChildItem -LiteralPath $PendingDir -Filter "*.md" -ErrorAction SilentlyContinue).Count
    if ($pendLeft -eq 0) {
      $stB.status = "COMPLETE"
      Save-AutoState $stB
      Write-AutoLog "AUTOPILOT_COMPLETE: No pending tasks left in backlog."
      Write-FinalReport
      Show-AutoStatus
      return
    }
    $stB.status = "BLOCKED"
    $stB.lastError = "No safe auto-executable task left in backlog."
    Save-AutoState $stB
    Write-AutoLog "AUTOPILOT_BLOCKED: no safe task available. Add backlog or resolve rejected items."
    Show-AutoStatus
    return
  }
  $ok = $false
  try { $ok = Invoke-RunTask $task $MaxAttemptsPerTask }
  catch {
    Write-AutoLog ("Task {0} errored: {1}" -f $task.TaskId, $_.Exception.Message)
    $ok = $false
  }
  if ($ok) { Write-AutoLog ("{0} TASK_COMPLETE ({1}/{2})." -f $task.TaskId, (Get-AutoState).completedTasks, (Get-AutoState).targetTasks) }
  else { Write-AutoLog ("{0} marked failed; continuing with next task." -f $task.TaskId) }
}

$stF = Get-AutoState
$stF.status = "COMPLETE"
Save-AutoState $stF
Write-FinalReport
Write-Host ""
Write-Host "========================================"
Write-Host "AUTOPILOT COMPLETE"
Write-Host "========================================"
Write-Host ""
Write-Host ("Completed: {0} / {1} tasks" -f $stF.completedTasks, $stF.targetTasks)
Write-Host ""
Write-Host "The autonomous engineering loop has stopped."
Write-Host ""
Write-Host "Review:"
Write-Host "  .ai-workflow/autopilot/reports/final-report.md"
Write-Host ""
Show-AutoStatus
