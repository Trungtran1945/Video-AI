<#
.SYNOPSIS
    Herdr Multi-Agent Team Runner
.DESCRIPTION
    Khởi động và điều phối đội ngũ 4 AI Agents (OpenCode Leader, OpenCode Backend, Antigravity Frontend, Antigravity Tester)
    trên Herdr một cách hoàn toàn tự động.
.EXAMPLE
    .\scripts\team.ps1 -InitOnly
.EXAMPLE
    .\scripts\team.ps1 "Sửa bug login và cập nhật style dashboard"
#>

param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Task,

    [switch]$InitOnly
)

$scriptPath = Join-Path $PSScriptRoot "team-orchestrator.mjs"
$nodeArgs = @($scriptPath)
if ($InitOnly) {
    $nodeArgs += "--init-only"
}
if ($Task -and $Task.Count -gt 0) {
    $nodeArgs += ($Task -join " ")
}

node @nodeArgs
