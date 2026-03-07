# recording_and_AI_summary

클로바노트 스타일 MVP를 위한 초기 프로젝트입니다.

## 구성
- `mobile-app/` : Expo(React Native) 앱
- `backend/` : FastAPI + OpenAI API 서버

## 핵심 기능 (현재 구현)
1. 과목 디렉토리(폴더) 생성
   - 태그: 전공 🎓 / 교양 📚 / 시험과목 📝
2. 과목별 녹음 파일 저장
3. 전사 방식 선택
   - API 자동 전사
   - 대화형 AI API 전사
4. 요약 방식 선택
   - API 자동 요약
   - 대화형 AI API 요약
5. 각 과목 폴더에 3개 파일 유지
   - `recording.m4a`
   - `transcript.txt`
   - `summary.txt`

## 빠른 시작

### 1) 백엔드 실행
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
# .env에서 OPENAI_API_KEY 설정
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2) 모바일 앱 실행
```bash
cd mobile-app
copy .env.example .env
npm install
npm run start
```

## API 엔드포인트
- `POST /api/transcribe` : 파일 -> 텍스트
- `POST /api/transcribe-chat` : 파일 -> 텍스트 (대화형 AI API)
- `POST /api/summarize` : 텍스트 -> 요약
- `POST /api/summarize-chat` : 텍스트 -> 요약 (대화형 AI API)
- `POST /api/process` : 파일 -> 텍스트 + 요약

## 중요 메모
- 백그라운드 녹음은 `expo-audio` 플러그인 설정을 반영한 Dev Build/Release 앱에서 안정적으로 동작합니다.
- 실제 폰 테스트 시 `EXPO_PUBLIC_API_BASE_URL`은 PC의 로컬 IP로 설정해야 합니다.
- 긴 강의 파일은 백엔드에서 자동 분할 전사를 지원합니다.
## Anywhere Usage (Cloud Backend)
Deploy backend to Render using the included `render.yaml`.

1. Push this repository to GitHub.
2. In Render, create **New + -> Blueprint** and select this repo.
3. Set `OPENAI_API_KEY` in Render environment variables.
4. Deploy and confirm: `https://<your-render-domain>/health` returns `{"status":"ok"}`.
5. Rebuild mobile app with:
   - `EXPO_PUBLIC_API_BASE_URL=https://<your-render-domain>`
