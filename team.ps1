<#
.SYNOPSIS
    Herdr Multi-Agent Team Runner (4 Roles: PLANNER, CODER, TESTER, REVIEWER)
.DESCRIPTION
    Khởi động và điều phối đội ngũ 4 AI Agents:
    1. PLANNER (OpenCode): Biến yêu cầu sơ sài thành đặc tả kỹ thuật chi tiết
    2. CODER (OpenCode hoặc Antigravity): Đọc kế hoạch, viết code, sửa bug
    3. TESTER (Antigravity): Tự đọc code, viết test cases cho edge cases, verify
    4. REVIEWER (Antigravity - Read-Only): Soi git diff, kiểm tra chất lượng, chốt hạ hoặc yêu cầu sửa
.EXAMPLE
    .\team.ps1 -InitOnly
    Hiện menu phím mũi tên [↑ / ↓] để chọn model cho CODER (OpenCode hoặc Antigravity).
.EXAMPLE
    .\team.ps1 "Nhiệm vụ cần làm"
.EXAMPLE
    .\team.ps1 "Nhiệm vụ cần làm" -Coder antigravity
#>

param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Task,

    [switch]$InitOnly,

    [ValidateSet("opencode", "antigravity", "agy")]
    [string]$Coder
)

$scriptPath = Join-Path $PSScriptRoot "scripts\team-orchestrator.mjs"
if (-not (Test-Path $scriptPath)) {
    $scriptPath = Join-Path $PSScriptRoot "team-orchestrator.mjs"
}

$nodeArgs = @($scriptPath)
if ($InitOnly) {
    $nodeArgs += "--init-only"
}
if ($Coder) {
    $nodeArgs += "--coder"
    $nodeArgs += $Coder
}
if ($Task -and $Task.Count -gt 0) {
    $nodeArgs += ($Task -join " ")
}

node @nodeArgs
