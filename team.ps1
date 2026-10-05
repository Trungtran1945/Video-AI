<#
.SYNOPSIS
    Herdr Multi-Agent Team Runner
.DESCRIPTION
    Khởi động và điều phối đội ngũ 4 AI Agents (OpenCode Leader, OpenCode Backend, Antigravity Frontend, Antigravity Tester)
    trên Herdr một cách hoàn toàn tự động.
.EXAMPLE
    .\team.ps1 -InitOnly
    Khởi tạo 4 ô Terminal và mở sẵn 4 AI Agent trên Herdr ở chế độ chờ.
.EXAMPLE
    .\team.ps1 "Sửa bug login và cập nhật style dashboard"
    Giao việc cho đội ngũ tự động chuyển giao tuần tự từ Plan -> Backend -> Frontend -> QA -> Report.
#>

param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Task,

    [switch]$InitOnly
)

$scriptPath = Join-Path $PSScriptRoot "scripts\team-orchestrator.mjs"
if (-not (Test-Path $scriptPath)) {
    $scriptPath = Join-Path $PSScriptRoot "team-orchestrator.mjs"
}

$nodeArgs = @($scriptPath)
if ($InitOnly) {
    $nodeArgs += "--init-only"
}
if ($Task -and $Task.Count -gt 0) {
    $nodeArgs += ($Task -join " ")
}

node @nodeArgs
