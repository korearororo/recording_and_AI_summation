[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Domain,
    [Parameter(Mandatory = $true)]
    [string]$OpenAIApiKey,
    [string]$BackendRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$BackendHost = "127.0.0.1",
    [int]$BackendPort = 8000,
    [string]$AllowedOrigins = "*",
    [string]$AuthDatabaseUrl = "",
    [string]$AuthMobileRedirectUri = "meetingnoteai://auth/callback",
    [string]$GoogleClientId = "",
    [string]$GoogleClientSecret = "",
    [string]$KakaoClientId = "",
    [string]$KakaoClientSecret = "",
    [string]$NaverClientId = "",
    [string]$NaverClientSecret = "",
    [switch]$InstallFfmpeg,
    [switch]$SkipCaddyInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script in an Administrator PowerShell window."
    }
}

function Ensure-Command {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$InstallHint
    )
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing command: $Name`nInstall first: $InstallHint"
    }
}

function Install-WithWingetIfMissing {
    param(
        [Parameter(Mandatory = $true)][string]$CommandName,
        [Parameter(Mandatory = $true)][string]$WingetId
    )
    if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
        return
    }
    Ensure-Command -Name "winget" -InstallHint "Install App Installer from Microsoft Store (winget)"
    Write-Host "Installing $CommandName via winget ($WingetId)..."
    winget install -e --id $WingetId --accept-source-agreements --accept-package-agreements --silent | Out-Host
}

function Ensure-FirewallRule {
    param(
        [Parameter(Mandatory = $true)][string]$DisplayName,
        [Parameter(Mandatory = $true)][int]$Port
    )
    $existing = Get-NetFirewallRule -DisplayName $DisplayName -ErrorAction SilentlyContinue
    if (-not $existing) {
        New-NetFirewallRule -DisplayName $DisplayName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
    }
}

Assert-Admin

$backendPath = (Resolve-Path $BackendRoot).Path
$requirementsPath = Join-Path $backendPath "requirements.txt"
$envPath = Join-Path $backendPath ".env"

if (-not (Test-Path $requirementsPath)) {
    throw "requirements.txt not found in backend path: $backendPath"
}

Ensure-Command -Name "python" -InstallHint "Install Python 3.11+"

if ($InstallFfmpeg) {
    Install-WithWingetIfMissing -CommandName "ffmpeg" -WingetId "Gyan.FFmpeg"
}

if (-not $SkipCaddyInstall) {
    Install-WithWingetIfMissing -CommandName "caddy" -WingetId "CaddyServer.Caddy"
}
Ensure-Command -Name "caddy" -InstallHint "Install Caddy (https://caddyserver.com/download)"

$venvPath = Join-Path $backendPath ".venv"
$venvPython = Join-Path $venvPath "Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    Write-Host "Creating virtual environment..."
    python -m venv $venvPath
}

Write-Host "Installing Python dependencies..."
& $venvPython -m pip install --upgrade pip | Out-Host
& $venvPython -m pip install -r $requirementsPath | Out-Host

$publicBaseUrl = "https://$Domain"

$envLines = @(
    "OPENAI_API_KEY=$OpenAIApiKey"
    "ALLOWED_ORIGINS=$AllowedOrigins"
    "AUTH_DATABASE_URL=$AuthDatabaseUrl"
    "AUTH_PUBLIC_BASE_URL=$publicBaseUrl"
    "AUTH_MOBILE_REDIRECT_URI=$AuthMobileRedirectUri"
    "GOOGLE_CLIENT_ID=$GoogleClientId"
    "GOOGLE_CLIENT_SECRET=$GoogleClientSecret"
    "KAKAO_CLIENT_ID=$KakaoClientId"
    "KAKAO_CLIENT_SECRET=$KakaoClientSecret"
    "NAVER_CLIENT_ID=$NaverClientId"
    "NAVER_CLIENT_SECRET=$NaverClientSecret"
)
Set-Content -Path $envPath -Value ($envLines -join "`r`n") -Encoding UTF8
Write-Host "Updated backend env file: $envPath"

$deployRoot = $PSScriptRoot
$runnerBackend = Join-Path $deployRoot "start-backend.ps1"
$runnerCaddy = Join-Path $deployRoot "start-caddy.ps1"
$deployLogDir = Join-Path $backendPath "logs"
if (-not (Test-Path $deployLogDir)) {
    New-Item -ItemType Directory -Path $deployLogDir -Force | Out-Null
}

$caddyfilePath = Join-Path $deployRoot "Caddyfile"
$caddyConfig = @"
{
    auto_https on
}

$Domain {
    encode gzip
    reverse_proxy $BackendHost`:$BackendPort
}
"@
Set-Content -Path $caddyfilePath -Value $caddyConfig -Encoding UTF8
Write-Host "Updated Caddyfile: $caddyfilePath"

$caddyExe = (Get-Command caddy -ErrorAction Stop).Source

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$backendArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerBackend`" -BackendRoot `"$backendPath`" -Host `"$BackendHost`" -Port $BackendPort"
$backendAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $backendArgs
Register-ScheduledTask -TaskName "RecordingAI-Backend" -Action $backendAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$caddyArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$runnerCaddy`" -CaddyExe `"$caddyExe`" -CaddyfilePath `"$caddyfilePath`" -LogDir `"$deployLogDir`""
$caddyAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $caddyArgs
Register-ScheduledTask -TaskName "RecordingAI-Caddy" -Action $caddyAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Ensure-FirewallRule -DisplayName "RecordingAI-HTTP-80" -Port 80
Ensure-FirewallRule -DisplayName "RecordingAI-HTTPS-443" -Port 443

Start-ScheduledTask -TaskName "RecordingAI-Backend"
Start-ScheduledTask -TaskName "RecordingAI-Caddy"

Write-Host ""
Write-Host "Setup completed."
Write-Host "Backend root: $backendPath"
Write-Host "Public URL: $publicBaseUrl"
Write-Host "Health check: $publicBaseUrl/health"
Write-Host ""
Write-Host "Important:"
Write-Host "1) Router port forwarding required: 80, 443 -> this server PC"
Write-Host "2) Domain DNS A record required -> your public IP"
Write-Host "3) For social login redirects, use:"
Write-Host "   - https://$Domain/api/auth/oauth/google/callback"
Write-Host "   - https://$Domain/api/auth/oauth/kakao/callback"
Write-Host "   - https://$Domain/api/auth/oauth/naver/callback"
