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
