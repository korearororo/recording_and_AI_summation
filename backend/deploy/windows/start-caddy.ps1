[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CaddyExe,
    [Parameter(Mandatory = $true)]
    [string]$CaddyfilePath,
    [Parameter(Mandatory = $true)]
    [string]$LogDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $CaddyExe)) {
    throw "caddy executable not found: $CaddyExe"
}
if (-not (Test-Path $CaddyfilePath)) {
    throw "Caddyfile not found: $CaddyfilePath"
}
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$logFile = Join-Path $LogDir "caddy.log"

while ($true) {
    $startedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$startedAt] Starting caddy with config: $CaddyfilePath"

    & $CaddyExe run --config $CaddyfilePath --adapter caddyfile *>> $logFile
    $exitCode = $LASTEXITCODE

    $endedAt = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "[$endedAt] Caddy stopped with exit code: $exitCode. Restarting in 5 seconds."
    Start-Sleep -Seconds 5
}
