# Recording & AI Summation - Worklog / Handoff

## Repository
- GitHub: `https://github.com/korearororo/recording_and_AI_summation.git`
- Main branch: `main`

## Current status
- Mobile app and backend are updated for:
  - transcription / translation / summary workflows
  - cloud upload / restore with Google Drive-backed library
  - restore reliability improvements (file id lookup, retries, status messages)
  - server-side download path optimized to reduce `502` risk

## Latest important commits
- `6528120` Fix cloud restore 502 by streaming Drive downloads and safer retry
- `97910fd` Improve cloud restore reliability with drive file_id fetch and clearer failure message
- `0ec93fa` Show status message panel on all screens

## What is intentionally NOT in git
- local debug dumps and screenshots
- local test/sample data folders
- device-specific temporary files

These are not required to continue development.

## Start on another computer
```bash
git clone https://github.com/korearororo/recording_and_AI_summation.git
cd recording_and_AI_summation
git checkout main
```

If already cloned:
```bash
git pull origin main
```

## Backend run (local)
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Mobile run (local dev)
```bash
cd mobile-app
npm install
npx expo start
```

## Production backend
- Hosted on Render.
- Must be `Live` for transcription/translation/summary and cloud sync APIs.

## Notes
- Local library data on a device/computer is separate from cloud backup unless user performs upload/restore.
- Do not delete local data unless explicitly requested by the user.
