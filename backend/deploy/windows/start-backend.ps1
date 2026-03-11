[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BackendRoot,
    [string]$Host = "127.0.0.1",
    [int]$Port = 8000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackendRoot)) {
    throw "BackendRoot not found: $BackendRoot"
}

$pythonPath = Join-Path $BackendRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonPath)) {
    throw "Python venv executable not found: $pythonPath"
}

$logDir = Join-Path $BackendRoot "logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = Join-Path $logDir "backend.log"

Set-Location $BackendRoot

while ($true) {
    $startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$startedAt] Starting backend server on $Host`:$Port"

    & $pythonPath -m uvicorn app.main:app --host $Host --port $Port *>> $logFile
    $exitCode = $LASTEXITCODE

    $endedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$endedAt] Backend stopped with exit code: $exitCode. Restarting in 5 seconds."
    Start-Sleep -Seconds 5
}
