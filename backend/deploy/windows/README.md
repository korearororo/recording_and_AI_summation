# Windows 24/7 Self-Hosting (Backend + HTTPS)

This folder provides scripts to run the backend 24/7 on a separate Windows PC.

What it sets up:
- Python backend (`uvicorn`) as a startup task
- Caddy reverse proxy with HTTPS as a startup task
- Windows firewall rules for ports 80/443

## 0) Prerequisites

1. Run on a server PC that stays on 24/7.
2. Install:
   - Python 3.11+
   - Git
   - (Optional) winget
3. Router:
   - Port forward TCP 80 and 443 to this server PC.
4. DNS:
   - Domain A record points to your public IP.

## 1) Clone and open Admin PowerShell

```powershell
git clone https://github.com/korearororo/recording_and_AI_summation.git
cd recording_and_AI_summation\backend\deploy\windows
```

Open PowerShell as Administrator, then run:

```powershell
.\setup-24x7-server.ps1 `
  -Domain "api.your-domain.com" `
  -OpenAIApiKey "sk-..." `
  -AuthDatabaseUrl "postgresql://user:pass@host:5432/dbname?sslmode=require" `
  -GoogleDriveEnabled $true `
  -GoogleDriveServiceAccountJson "{...json...}" ` # or OAuth settings below
  -GoogleDriveRootFolderId "1AbCdEfGh..." `
  -GoogleDriveOAuthClientId "..." `
  -GoogleDriveOAuthClientSecret "..." `
  -GoogleDriveOAuthRefreshToken "..." `
  -InstallFfmpeg
```

Notes:
- `-InstallFfmpeg` is recommended for long audio chunking support.
- Caddy is installed via winget if missing (unless `-SkipCaddyInstall` is used).
- `-AuthDatabaseUrl` is optional. If set, login data is stored in persistent PostgreSQL.
- `-GoogleDriveEnabled` with either:
  - service account JSON (`-GoogleDriveServiceAccountJson`), or
  - OAuth refresh token (`-GoogleDriveOAuthClientId/Secret/RefreshToken`).

## 2) Verify

```powershell
Get-ScheduledTask RecordingAI-Backend,RecordingAI-Caddy
Invoke-WebRequest https://api.your-domain.com/health
```

Expected health response:

```json
{"status":"ok"}
```

## 3) Social login redirect URIs

Register these in Google/Kakao/Naver developer consoles:

- `https://api.your-domain.com/api/auth/oauth/google/callback`
- `https://api.your-domain.com/api/auth/oauth/kakao/callback`
- `https://api.your-domain.com/api/auth/oauth/naver/callback`

## 4) Logs

- Backend log: `backend\logs\backend.log`
- Caddy log: `backend\logs\caddy.log`

## 5) Start/stop/restart tasks

```powershell
Start-ScheduledTask -TaskName RecordingAI-Backend
Start-ScheduledTask -TaskName RecordingAI-Caddy

Stop-ScheduledTask -TaskName RecordingAI-Backend
Stop-ScheduledTask -TaskName RecordingAI-Caddy
```

## 6) Update after code changes

```powershell
cd recording_and_AI_summation
git pull
cd backend\deploy\windows
.\setup-24x7-server.ps1 -Domain "api.your-domain.com" -OpenAIApiKey "sk-..."
```

Running setup again is safe. It refreshes `.env`, Caddyfile, and startup tasks.
