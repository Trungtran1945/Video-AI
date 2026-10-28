<#
.SYNOPSIS
    Herdr Multi-Agent Team Runner (4 Roles: PLANNER, CODER, TESTER, REVIEWER)
.DESCRIPTION
    Khởi động và điều phối đội ngũ 4 AI Agents:
    1. PLANNER (Tự chọn: OpenCode hoặc Antigravity): Biến yêu cầu sơ sài thành đặc tả kỹ thuật chi tiết
    2. CODER (Tự chọn: OpenCode hoặc Antigravity): Đọc kế hoạch, viết code, sửa bug
    3. TESTER (Antigravity): Tự đọc code, viết test cases cho edge cases, verify
    4. REVIEWER (Antigravity - Read-Only): Soi git diff, kiểm tra chất lượng, chốt hạ hoặc yêu cầu sửa

    Chế độ hoạt động:
    - Tiêu chuẩn (Mặc định): Chạy 1 lượt (Planner -> Coder -> Tester -> Reviewer) rồi kết thúc.
    - Xoay vòng tự động (-Loop): Reviewer đánh giá & đề xuất kế hoạch -> giao lại Planner -> Coder -> Tester -> lặp lại tối đa N vòng.
.EXAMPLE
    team -InitOnly
    Hiện menu phím mũi tên [↑ / ↓] để chọn model cho PLANNER, CODER, chế độ thực thi và số vòng lặp tối đa.
.EXAMPLE
    team "Nhiệm vụ cần làm"
    Chạy theo cấu hình đã lưu.
.EXAMPLE
    team "Nhiệm vụ cần làm" -Loop -MaxLoops 3
    Chạy ở chế độ xoay vòng tự động tối đa 3 vòng lặp.
.EXAMPLE
    team "Nhiệm vụ cần làm" -Once
    Chạy ở chế độ tiêu chuẩn (1 lượt).
.EXAMPLE
    team -Resume
    Bỏ qua PLANNER, tiếp tục chạy thẳng từ bước CODER (dựa trên PLAN.md đã có).
.EXAMPLE
    team -From coder
.EXAMPLE
    team "Nhiệm vụ cần làm" -Planner antigravity -Coder opencode
#>

param(
    [Parameter(Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$Task,

    [switch]$InitOnly,

    [switch]$Resume,

    [ValidateSet("planner", "coder", "tester", "reviewer")]
    [string]$From,

    [ValidateSet("opencode", "antigravity", "agy")]
    [string]$Planner,

    [ValidateSet("opencode", "antigravity", "agy")]
    [string]$Coder,

    [ValidateSet("once", "loop")]
    [string]$Mode,

    [switch]$Loop,

    [switch]$Once,

    [int]$MaxLoops = 0
)

$scriptPath = Join-Path $PSScriptRoot "scripts\team-orchestrator.mjs"
if (-not (Test-Path $scriptPath)) {
    $scriptPath = Join-Path $PSScriptRoot "team-orchestrator.mjs"
}

$nodeArgs = @($scriptPath)
if ($InitOnly) {
    $nodeArgs += "--init-only"
}
if ($Resume) {
    $nodeArgs += "--resume"
}
if ($From) {
    $nodeArgs += "--from"
    $nodeArgs += $From
}
if ($Planner) {
    $nodeArgs += "--planner"
    $nodeArgs += $Planner
}
if ($Coder) {
    $nodeArgs += "--coder"
    $nodeArgs += $Coder
}
if ($Loop) {
    $nodeArgs += "--loop"
}
if ($Once) {
    $nodeArgs += "--once"
}
if ($Mode) {
    $nodeArgs += "--mode"
    $nodeArgs += $Mode
}
if ($MaxLoops -gt 0) {
    if (-not $Once -and -not $Mode -and -not $Loop) {
        $nodeArgs += "--loop"
    }
    $nodeArgs += "--max-loops"
    $nodeArgs += $MaxLoops.ToString()
}
if ($Task -and $Task.Count -gt 0) {
    $nodeArgs += ($Task -join " ")
}

node @nodeArgs
