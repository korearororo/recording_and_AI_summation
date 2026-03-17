# AI Agent Handoff (Quick Context)

## 1) Repo Snapshot
- Repo: `recording_and_AI_summation`
- Branch: `main`
- Latest commit: `b341132` (`feat: improve mobile export/UI and harden cloud/auth flow`)

## 2) What Changed In Latest Work

### `mobile-app/App.tsx`
- Added **bulk local export to Android "My Files"** via SAF:
  - Button in home screen: `로컬 파일 내보내기 (내 파일)`
  - Exports `subjects/*` + `pending-jobs.json` + `cloud-md5-cache.json`
  - Creates `export-manifest.json`
- Improved cloud/auth robustness:
  - Added `fetchWithTimeout(...)`
  - `restoreAuthSession()` now uses timeout for `/api/auth/me`
  - `refreshCloudRootDir()` now uses timeout for `/api/library`
  - Goal: app should still load local folders even if backend is slow/down
- UI change:
  - In recording save modal, folder list now scrolls (`ScrollView`) so save buttons no longer block folder selection.
- Cloud status visibility:
  - Added storage mode label:
    - `Google Drive` if `root_dir` starts with `drive://folder/`
    - otherwise `서버 로컬 스토리지`

### `render.yaml`
- Changed:
  - `GOOGLE_DRIVE_ENABLED: "false" -> "true"`
- Important: this alone is not sufficient. Drive credentials must also exist in Render env.

### `backend/README.md`
- Updated storage path description to match actual backend structure:
  - `entries/<entry_key>/recording__*`, `transcript__*`, `translation__*`, `summary__*`
- Added explicit note:
  - `GOOGLE_DRIVE_ENABLED=true` + valid credentials required for Drive mode

## 3) Current Known Operational Issues

### A) Login may fail when backend is unresponsive
- Symptom:
  - app shows login failures / cloud calls fail
  - `https://recording-ai-backend.onrender.com/health` timeout
- Cause:
  - Render backend service unhealthy/sleeping/hung
- Action:
  1. Render dashboard -> manual restart/redeploy backend
  2. confirm `/health` returns quickly
  3. retry login

### B) Local vs Drive confusion
- If app shows `저장 백엔드: 서버 로컬 스토리지`, uploads are not going to Drive.
- Backend switches to Drive only if:
  - `GOOGLE_DRIVE_ENABLED=true`
  - and one credential path is complete:
    - `GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON`
    - or OAuth trio:
      - `GOOGLE_DRIVE_OAUTH_CLIENT_ID`
      - `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`
      - `GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN`

### C) Dev-client "Unable to load script"
- Symptom:
  - `Unable to load script` / packager not running
- Fix:
  1. Run Metro (`expo start --dev-client`)
  2. `adb reverse tcp:8081 tcp:8081`

## 4) Verified Device State (important)
- Android package: `com.jinwoo.recordingaisummary`
- Existing app data is preserved after `adb install -r`
- Verified internal storage contains:
  - `files/subjects/*` (multiple subject folders)
  - `files/auth-session.json`
  - `files/cloud-md5-cache.json`
  - `files/pending-jobs.json`

## 5) Fast Validation Checklist (for next agent)
1. Open app home:
   - folder list should render
2. Check cloud box:
   - verify storage mode label (`Google Drive` or local)
3. Test upload:
   - success message should include `저장위치: ...`
   - Drive mode expected: `drive://folder/...`
4. If auth/cloud fails:
   - test backend `/health` first
5. If app blank/error in dev build:
   - verify Metro + `adb reverse` first

## 6) Files Most Relevant For Further Edits
- `mobile-app/App.tsx`
- `render.yaml`
- `backend/app/main.py` (storage mode branch logic)
- `backend/app/services/google_drive_library.py`
- `backend/README.md`

