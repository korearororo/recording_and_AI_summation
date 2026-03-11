# Backend (FastAPI)

## Run

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## Cloud Deploy (Anywhere Usage)
If you want to use the app from any network (not only your home/PC LAN), deploy this backend to a public cloud URL.

1. Deploy `backend/` as a Docker web service (Render/Railway/Fly.io).
2. Set environment variables on the cloud service:
   - `OPENAI_API_KEY=<your key>`
   - `ALLOWED_ORIGINS=*` (or your exact app origin list)
   - `AUTH_DATABASE_URL=<postgres connection string>` (recommended for persistent login DB)
   - `GOOGLE_DRIVE_ENABLED=true` (if you want library storage in Google Drive)
   - `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON=<service account json string or file path>` OR OAuth below
   - `GOOGLE_DRIVE_OAUTH_CLIENT_ID=<oauth client id>`
   - `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET=<oauth client secret>`
   - `GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN=<oauth refresh token>`
   - `GOOGLE_DRIVE_ROOT_FOLDER_ID=<optional drive folder id>`
   - `AUTH_PUBLIC_BASE_URL=https://<your-backend-domain>`
   - `AUTH_MOBILE_REDIRECT_URI=meetingnoteai://auth/callback`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `KAKAO_CLIENT_ID` (`KAKAO_CLIENT_SECRET` optional)
   - `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
3. Confirm health check:
   - `GET https://<your-backend-domain>/health` -> `{"status":"ok"}`
4. Rebuild mobile app with:
   - `EXPO_PUBLIC_API_BASE_URL=https://<your-backend-domain>`

## Windows 24/7 Self-Hosting
If you want to run this on your own Windows PC (always-on server), use:

- [backend/deploy/windows/README.md](./deploy/windows/README.md)

One-command setup script:

```powershell
cd backend\deploy\windows
.\setup-24x7-server.ps1 -Domain "api.your-domain.com" -OpenAIApiKey "sk-..." -InstallFfmpeg
```

## API
- `POST /api/transcribe` : audio file -> transcript
- `POST /api/transcribe-chat` : audio file -> transcript (chat model refinement)
- `POST /api/summarize` : transcript -> summary
- `POST /api/summarize-chat` : transcript -> summary (chat model prompt)
- `POST /api/process` : audio file -> transcript + summary
- `GET /api/auth/oauth/{provider}/start` : social login start redirect (`provider`: `google|kakao|naver`)
- `GET /api/auth/oauth/{provider}/callback` : social login callback -> app deep link redirect

## Storage Paths
- Auth DB:
  - If `AUTH_DATABASE_URL` is set: PostgreSQL (persistent)
  - Otherwise: local SQLite `backend/auth/auth.db` (can be ephemeral on free cloud instances)
- Uploaded library files:
  - Local mode (default): `LIBRARY_ROOT` (default `backend/library`)
    - Per-user folder: `library/user_<user_id>/`
    - Per-subject folder: `<subject_name>__<subject_id>/recordings|transcripts|translations|summaries`
  - Google Drive mode (`GOOGLE_DRIVE_ENABLED=true`):
    - Root folder: `GOOGLE_DRIVE_ROOT_FOLDER_ID` (or auto-created `RecordingAI-Library`)
    - Per-user folder: `user_<user_id>`
    - Per-subject folder: `<subject_name>__<subject_id>/recordings|transcripts|translations|summaries`
    - Auth options:
      - Service account JSON (best with Shared Drive)
      - OAuth refresh token (recommended for personal Google Drive)

### Google Drive Service Account Note
- `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON` can be:
  - Full JSON string itself, or
  - Absolute file path to a JSON file (self-hosted Windows/Linux)
- On Render, set it as secret env var with the full JSON string.
- If you see `storageQuotaExceeded` with service account, switch to OAuth refresh token mode.

### Generate Drive OAuth Refresh Token
```bash
cd backend
python scripts/get_google_drive_refresh_token.py \
  --client-id "<GOOGLE_DRIVE_OAUTH_CLIENT_ID>" \
  --client-secret "<GOOGLE_DRIVE_OAUTH_CLIENT_SECRET>"
```

## Optional: Migrate Existing SQLite Auth Data to PostgreSQL
If users already signed up on SQLite and you want to keep those accounts:

```bash
cd backend
python scripts/migrate_auth_sqlite_to_postgres.py \
  --sqlite-path ./auth/auth.db \
  --postgres-url "postgresql://USER:PASSWORD@HOST:5432/DB?sslmode=require"
```

## Long Lecture Transcription
- Files larger than `TRANSCRIBE_MAX_FILE_MB` are automatically split and transcribed chunk-by-chunk.
- Splitting uses `ffmpeg` and concatenates chunk transcripts in order.
- Tunable env vars:
  - `TRANSCRIBE_MAX_FILE_MB` (default `24`)
  - `TRANSCRIBE_CHUNK_MINUTES` (default `10`)
  - `TRANSCRIBE_CHUNK_BITRATE` (default `64k`)
  - `TRANSCRIBE_PARALLEL_CHUNKS` (default `3`)
  - `OPENAI_TIMEOUT_SECONDS` (default `300`)
  - `OPENAI_MAX_RETRIES` (default `1`)
  - `CHAT_TRANSCRIBE_MODEL` (default `gpt-4.1-mini`)
  - `CHAT_SUMMARY_MODEL` (default `gpt-4.1-mini`)
