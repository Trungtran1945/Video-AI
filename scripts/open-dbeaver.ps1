# Launch DBeaver connected to Video_AI PostgreSQL
$dbeaverDir = "C:\Users\Tran Huu Trung\AppData\Local\DBeaver"
$dbeaverPath = Join-Path $dbeaverDir "dbeaver.exe"

if (-not (Test-Path $dbeaverPath)) {
    Write-Host "[ERROR] DBeaver executable not found at: $dbeaverPath" -ForegroundColor Red
    exit 1
}

Write-Host "Opening DBeaver for Video_AI..." -ForegroundColor Cyan
Write-Host "Pre-configured Connection: Video_AI (localhost:5433 / video_ai)" -ForegroundColor Green

Start-Process -FilePath $dbeaverPath -WorkingDirectory $dbeaverDir
Write-Host "[SUCCESS] DBeaver launched successfully." -ForegroundColor Green
