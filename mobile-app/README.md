# Mobile App (Expo)

## Run

```bash
cd mobile-app
copy .env.example .env
npm install
npm run start
```

## Android APK 설치용 빌드 (EAS)
1. EAS 로그인
```bash
npx eas login
```
2. 프로젝트 연결 (최초 1회)
```bash
npx eas build:configure
```
3. APK 빌드
```bash
npm run build:android:preview
```
4. 빌드 완료 후 EAS 링크에서 APK 다운로드 후 휴대폰 설치

## 핵심 워크플로우
1. 과목 폴더 생성 + 태그 선택
   - 전공 🎓 / 교양 📚 / 시험과목 📝
2. 과목별 녹음 및 저장 (`recording.m4a`)
3. 전사 방식 선택
   - `API 자동`: 백엔드 `/api/transcribe` 호출
   - `대화형 AI API`: 백엔드 `/api/transcribe-chat` 호출
4. 요약 방식 선택
   - `API 자동`: 백엔드 `/api/summarize` 호출
   - `대화형 AI API`: 백엔드 `/api/summarize-chat` 호출
5. 과목 폴더 내 3개 파일 유지
   - `recording.m4a`
   - `transcript.txt`
   - `summary.txt`
6. 앱 내 파일 접근 버튼
   - `5) 저장 상태` 카드에서 폴더 경로 표시
   - `녹음 내보내기 / 전사 내보내기 / 요약 내보내기` 버튼 제공

## Notes
- `EXPO_PUBLIC_API_BASE_URL` should point to your backend host.
- Android emulator default: `http://10.0.2.2:8000`
- iOS simulator default: `http://localhost:8000`
- Physical phone: use your PC LAN IP (for example `http://192.168.0.10:8000`).

## Background Recording
- Requires Dev Build or Release build with `expo-audio` plugin settings.
- Expo Go may not keep recording reliably in background on all devices.
