# Script to test PostgreSQL connection for Video_AI
param(
    [string]$HostName = "localhost",
    [int]$Port = 5433,
    [string]$Database = "video_ai",
    [string]$User = "video_ai_user",
    [string]$Password = "VideoAI_Secure_Db_2026!"
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Testing Video_AI PostgreSQL Connection" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Host:     $HostName"
Write-Host "Port:     $Port"
Write-Host "Database: $Database"
Write-Host "User:     $User"
Write-Host ""

$psqlPath = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
if (Test-Path $psqlPath) {
    $env:PGPASSWORD = $Password
    & $psqlPath -h $HostName -p $Port -U $User -d $Database -c "SELECT current_user, current_database(), version(), count(*) as table_count FROM information_schema.tables WHERE table_schema='public' GROUP BY 1, 2, 3;"
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "[SUCCESS] PostgreSQL connection verified successfully!" -ForegroundColor Green
        exit 0
    } else {
        Write-Host ""
        Write-Host "[ERROR] Failed to connect using psql." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[INFO] psql.exe not found at default location. Testing TCP port connectivity..."
    $tcp = Test-NetConnection -ComputerName $HostName -Port $Port
    if ($tcp.TcpTestSucceeded) {
        Write-Host "[SUCCESS] TCP connection to $HostName`:$Port succeeded!" -ForegroundColor Green
        exit 0
    } else {
        Write-Host "[ERROR] Could not establish TCP connection to $HostName`:$Port." -ForegroundColor Red
        exit 1
    }
}
