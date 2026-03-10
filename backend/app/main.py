from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse

from app.config import Settings, get_settings
from app.schemas import (
    AuthLoginRequest,
    AuthRegisterRequest,
    AuthSessionResponse,
    AuthUser,
    AsyncSummarizeRequest,
    AsyncTranslateRequest,
    JobCreateResponse,
    JobStatusResponse,
    LibrarySyncResponse,
    ProcessResponse,
    SummarizeRequest,
    SummarizeResponse,
    TranslateRequest,
    TranslateResponse,
    TranscriptionResponse,
)
from app.services.auth_store import AuthStore
from app.services.auth_store_postgres import AuthStorePostgres
from app.services.openai_service import OpenAIService

app = FastAPI(title="Recording & AI Summary API", version="0.1.0")

JOB_EXECUTOR = ThreadPoolExecutor(max_workers=2)
JOB_LOCK = Lock()
JOBS: dict[str, dict[str, object]] = {}
JOB_STORE_BOOTSTRAPPED = False
AUTH_LOCK = Lock()
AUTH_STORE: AuthStore | AuthStorePostgres | None = None
SUPPORTED_OAUTH_PROVIDERS = {"google", "kakao", "naver"}


def _configure_cors(settings: Settings) -> None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


_configure_cors(get_settings())


@app.on_event("startup")
def _bootstrap_persistent_state() -> None:
    _bootstrap_job_store(get_settings())


def _require_api_key(settings: Settings = Depends(get_settings)) -> None:
    if not settings.openai_api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing")


def _resolve_auth_db_path(settings: Settings) -> Path:
    path = Path(settings.auth_db_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    return path


def _resolve_job_store_path(settings: Settings) -> Path:
    path = Path(settings.job_store_path)
    if not path.is_absolute():
        path = Path(__file__).resolve().parents[1] / path
    return path


def _clone_jobs(source: dict[str, dict[str, object]]) -> dict[str, dict[str, object]]:
    return {job_id: dict(value) for job_id, value in source.items()}


def _prune_jobs_locked(settings: Settings) -> None:
    limit = max(50, settings.job_store_max_items)
    if len(JOBS) <= limit:
        return

    sortable = sorted(
        (
            float(value.get("updated_at") or 0.0),
            str(value.get("status") or ""),
            job_id,
        )
        for job_id, value in JOBS.items()
    )

    # Prefer pruning terminal jobs first; keep queued/running jobs when possible.
    for _, status, job_id in sortable:
        if len(JOBS) <= limit:
            break
        if status in {"completed", "failed"}:
            JOBS.pop(job_id, None)

    # If still above the limit, prune oldest jobs regardless of status.
    for _, _, job_id in sortable:
        if len(JOBS) <= limit:
            break
        JOBS.pop(job_id, None)


def _write_jobs_snapshot(settings: Settings, snapshot: dict[str, dict[str, object]]) -> None:
    target = _resolve_job_store_path(settings)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_target = target.with_suffix(f"{target.suffix}.tmp")
    temp_target.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
    temp_target.replace(target)


def _try_write_jobs_snapshot(settings: Settings, snapshot: dict[str, dict[str, object]]) -> None:
    try:
        _write_jobs_snapshot(settings, snapshot)
    except Exception:
        # Keep serving requests even when local disk persistence temporarily fails.
        pass


def _load_jobs(settings: Settings) -> None:
    target = _resolve_job_store_path(settings)
    if not target.exists():
        return

    try:
        parsed = json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return

    if not isinstance(parsed, dict):
        return

    loaded: dict[str, dict[str, object]] = {}
    now = _now_ts()
    has_recovered_jobs = False
    for raw_job_id, raw_value in parsed.items():
        if not isinstance(raw_job_id, str) or not isinstance(raw_value, dict):
            continue
        item = dict(raw_value)
        item["job_id"] = raw_job_id
        status = str(item.get("status") or "failed")
        if status in {"queued", "running"}:
            item["status"] = "failed"
            item["error"] = "Job interrupted by server restart."
            file_name = str(item.get("file_name") or "file")
            item["message"] = f"{file_name} processing interrupted (server restart)"
            item["updated_at"] = now
            has_recovered_jobs = True
        loaded[raw_job_id] = item

    with JOB_LOCK:
        JOBS.clear()
        JOBS.update(loaded)
        _prune_jobs_locked(settings)
        snapshot = _clone_jobs(JOBS)

    if has_recovered_jobs:
        _try_write_jobs_snapshot(settings, snapshot)


def _bootstrap_job_store(settings: Settings) -> None:
    global JOB_STORE_BOOTSTRAPPED
    if JOB_STORE_BOOTSTRAPPED:
        return
    with JOB_LOCK:
        if JOB_STORE_BOOTSTRAPPED:
            return
        JOB_STORE_BOOTSTRAPPED = True
    _load_jobs(settings)


def _get_auth_store(settings: Settings) -> AuthStore | AuthStorePostgres:
    global AUTH_STORE
    if AUTH_STORE is None:
        with AUTH_LOCK:
            if AUTH_STORE is None:
                database_url = settings.auth_database_url.strip()
                if database_url:
                    AUTH_STORE = AuthStorePostgres(
                        database_url=database_url,
                        session_ttl_hours=settings.auth_session_hours,
                    )
                else:
                    AUTH_STORE = AuthStore(
                        db_path=_resolve_auth_db_path(settings),
                        session_ttl_hours=settings.auth_session_hours,
                    )
    return AUTH_STORE


def _extract_bearer_token(authorization: str | None) -> str:
    raw = (authorization or "").strip()
    if not raw:
        return ""
    prefix = "bearer "
    if raw.lower().startswith(prefix):
        return raw[len(prefix) :].strip()
    return ""


def _require_user(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    token = _extract_bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=401, detail="Authorization token is required")
    user = _get_auth_store(settings).get_user_by_token(token)
    if user is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return user


def _save_upload_to_temp(upload: UploadFile) -> str:
    extension = Path(upload.filename or "recording.m4a").suffix or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as temp_file:
        shutil.copyfileobj(upload.file, temp_file)
        return temp_file.name


def _resolve_library_root(settings: Settings, user_id: str | None = None) -> Path:
    root = Path(settings.library_root)
    if not root.is_absolute():
        root = Path(__file__).resolve().parents[1] / root
    if user_id:
        root = root / f"user_{_safe_segment(user_id)}"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_segment(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_", " ") else "_" for ch in value)
    collapsed = "_".join(cleaned.split())
    return (collapsed[:80] or "untitled").strip("_")


def _safe_file_name(value: str, fallback: str) -> str:
    candidate = Path(value or fallback).name.strip()
    if not candidate:
        candidate = fallback
    if candidate in {".", ".."}:
        candidate = fallback
    return candidate.replace("\\", "_").replace("/", "_")


def _find_subject_dir(root: Path, subject_id: str) -> Path | None:
    suffix = f"__{_safe_segment(subject_id)}"
    for entry in root.iterdir():
        if entry.is_dir() and entry.name.endswith(suffix):
            return entry
    return None


def _subject_library_dir(settings: Settings, subject_id: str, subject_name: str, user_id: str) -> Path:
    root = _resolve_library_root(settings, user_id)
    existing = _find_subject_dir(root, subject_id)
    if existing is not None:
        return existing
    folder_name = f"{_safe_segment(subject_name or subject_id)}__{_safe_segment(subject_id)}"
    target = root / folder_name
    target.mkdir(parents=True, exist_ok=True)
    return target


def _subject_meta_path(target_dir: Path) -> Path:
    return target_dir / "meta.json"


def _load_subject_meta(target_dir: Path) -> dict[str, object]:
    meta_path = _subject_meta_path(target_dir)
    if not meta_path.exists():
        return {}
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_subject_meta(target_dir: Path, meta: dict[str, object]) -> None:
    _subject_meta_path(target_dir).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _subject_data_dir(target_dir: Path, kind: str) -> Path:
    mapping = {
        "recording": target_dir / "recordings",
        "transcript": target_dir / "transcripts",
        "translation": target_dir / "translations",
        "summary": target_dir / "summaries",
    }
    if kind not in mapping:
        raise HTTPException(status_code=400, detail="kind must be one of: recording, transcript, translation, summary")
    data_dir = mapping[kind]
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _resolve_library_file(settings: Settings, user_id: str, subject_id: str, kind: str, name: str) -> Path:
    root = _resolve_library_root(settings, user_id)
    subject_dir = _find_subject_dir(root, subject_id)
    if subject_dir is None:
        raise HTTPException(status_code=404, detail="subject not found")

    safe_name = _safe_file_name(name, "file.bin")
    target = _subject_data_dir(subject_dir, kind) / safe_name
    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")
    return target


def _copy_upload_to(upload: UploadFile, target_path: Path) -> None:
    with target_path.open("wb") as out_file:
        shutil.copyfileobj(upload.file, out_file)


def _now_ts() -> float:
    return time.time()


def _create_job(job_type: str, mode: str, file_name: str, expo_push_token: str | None) -> dict[str, object]:
    settings = get_settings()
    _bootstrap_job_store(settings)

    job_id = str(uuid.uuid4())
    now = _now_ts()
    record: dict[str, object] = {
        "job_id": job_id,
        "status": "queued",
        "job_type": job_type,
        "mode": mode,
        "file_name": file_name,
        "message": f"{file_name} {job_type} 대기중",
        "transcript": None,
        "translation": None,
        "summary": None,
        "error": None,
        "expo_push_token": expo_push_token or "",
        "created_at": now,
        "updated_at": now,
    }
    with JOB_LOCK:
        JOBS[job_id] = record
        _prune_jobs_locked(settings)
        snapshot = _clone_jobs(JOBS)
    _try_write_jobs_snapshot(settings, snapshot)
    return record


def _update_job(job_id: str, **kwargs: object) -> None:
    settings = get_settings()
    _bootstrap_job_store(settings)

    with JOB_LOCK:
        item = JOBS.get(job_id)
        if item is None:
            return
        item.update(kwargs)
        item["updated_at"] = _now_ts()
        _prune_jobs_locked(settings)
        snapshot = _clone_jobs(JOBS)
    _try_write_jobs_snapshot(settings, snapshot)


def _get_job(job_id: str) -> dict[str, object] | None:
    _bootstrap_job_store(get_settings())

    with JOB_LOCK:
        item = JOBS.get(job_id)
        if item is None:
            return None
        return dict(item)


def _send_push_notification(
    expo_push_token: str | None,
    title: str,
    body: str,
    data: dict[str, object] | None = None,
) -> None:
    token = (expo_push_token or "").strip()
    if not token:
        return
    if not (token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken[")):
        return

    payload = {
        "to": token,
        "title": title,
        "body": body,
        "data": data or {},
        "priority": "high",
        "sound": "default",
    }

    request = urllib_request.Request(
        "https://exp.host/--/api/v2/push/send",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(request, timeout=10):
            pass
    except Exception:
        # Push notification failure should not fail the core processing flow.
        pass


def _run_transcribe_job(job_id: str, file_path: str, mode: str, file_name: str, expo_push_token: str | None) -> None:
    _update_job(job_id, status="running", message=f"{file_name} 전사중")
    _send_push_notification(
        expo_push_token,
        "전사 시작",
        f"{file_name} 전사중",
        {"job_id": job_id, "job_type": "transcribe", "status": "running"},
    )

    try:
        service = OpenAIService()
        if mode == "chat":
            transcript = service.transcribe_with_chat(file_path)
        else:
            transcript = service.transcribe_file(file_path)

        _update_job(job_id, status="completed", transcript=transcript, message=f"{file_name} 전사 완료")
        _send_push_notification(
            expo_push_token,
            "전사 완료",
            f"{file_name} 전사가 완료되었습니다.",
            {"job_id": job_id, "job_type": "transcribe", "status": "completed"},
        )
    except Exception as exc:
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{file_name} 전사 실패")
        _send_push_notification(
            expo_push_token,
            "전사 실패",
            f"{file_name} 전사에 실패했습니다.",
            {"job_id": job_id, "job_type": "transcribe", "status": "failed"},
        )
    finally:
        if os.path.exists(file_path):
            os.remove(file_path)


def _run_summarize_job(job_id: str, transcript: str, mode: str, file_name: str, expo_push_token: str | None) -> None:
    _update_job(job_id, status="running", message=f"{file_name} 요약중")
    _send_push_notification(
        expo_push_token,
        "요약 시작",
        f"{file_name} 요약중",
        {"job_id": job_id, "job_type": "summarize", "status": "running"},
    )

    try:
        service = OpenAIService()
        if mode == "chat":
            summary = service.summarize_with_chat(transcript)
        else:
            summary = service.summarize_transcript(transcript)

        _update_job(job_id, status="completed", summary=summary, message=f"{file_name} 요약 완료")
        _send_push_notification(
            expo_push_token,
            "요약 완료",
            f"{file_name} 요약이 완료되었습니다.",
            {"job_id": job_id, "job_type": "summarize", "status": "completed"},
        )
    except Exception as exc:
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{file_name} 요약 실패")
        _send_push_notification(
            expo_push_token,
            "요약 실패",
            f"{file_name} 요약에 실패했습니다.",
            {"job_id": job_id, "job_type": "summarize", "status": "failed"},
        )


def _run_translate_job(
    job_id: str,
    text: str,
    target_language: str,
    mode: str,
    file_name: str,
    expo_push_token: str | None,
) -> None:
    _update_job(job_id, status="running", message=f"{file_name} 번역중")
    _send_push_notification(
        expo_push_token,
        "번역 시작",
        f"{file_name} 번역중",
        {"job_id": job_id, "job_type": "translate", "status": "running"},
    )

    try:
        service = OpenAIService()
        if mode == "chat":
            translation = service.translate_with_chat(text, target_language)
        else:
            translation = service.translate_text(text, target_language)

        _update_job(job_id, status="completed", translation=translation, message=f"{file_name} 번역 완료")
        _send_push_notification(
            expo_push_token,
            "번역 완료",
            f"{file_name} 번역이 완료되었습니다.",
            {"job_id": job_id, "job_type": "translate", "status": "completed"},
        )
    except Exception as exc:
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{file_name} 번역 실패")
        _send_push_notification(
            expo_push_token,
            "번역 실패",
            f"{file_name} 번역에 실패했습니다.",
            {"job_id": job_id, "job_type": "translate", "status": "failed"},
        )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _build_auth_session_response(user: dict[str, str], token: str, expires_at: float) -> AuthSessionResponse:
    return AuthSessionResponse(
        access_token=token,
        token_type="bearer",
        expires_at=expires_at,
        user=AuthUser(
            id=user["id"],
            email=user["email"],
            display_name=user["display_name"],
        ),
    )


def _normalize_oauth_provider(provider: str) -> str:
    value = provider.strip().lower()
    if value not in SUPPORTED_OAUTH_PROVIDERS:
        raise HTTPException(status_code=400, detail="provider must be one of: google, kakao, naver")
    return value


def _oauth_client_config(settings: Settings, provider: str) -> tuple[str, str]:
    if provider == "google":
        client_id = settings.google_client_id.strip()
        client_secret = settings.google_client_secret.strip()
    elif provider == "kakao":
        client_id = settings.kakao_client_id.strip()
        client_secret = settings.kakao_client_secret.strip()
    else:
        client_id = settings.naver_client_id.strip()
        client_secret = settings.naver_client_secret.strip()

    if not client_id:
        raise HTTPException(status_code=400, detail=f"{provider.upper()} client id is not configured")
    if provider in {"google", "naver"} and not client_secret:
        raise HTTPException(status_code=400, detail=f"{provider.upper()} client secret is not configured")
    return client_id, client_secret


def _build_oauth_callback_url(settings: Settings, request: Request, provider: str) -> str:
    base_url = settings.auth_public_base_url.strip().rstrip("/")
    if not base_url:
        forwarded_proto = (request.headers.get("x-forwarded-proto") or "").strip()
        forwarded_host = (request.headers.get("x-forwarded-host") or "").strip()
        scheme = forwarded_proto or request.url.scheme
        host = forwarded_host or request.url.netloc
        base_url = f"{scheme}://{host}"
    return f"{base_url}/api/auth/oauth/{provider}/callback"


def _append_query_to_url(url: str, params: dict[str, str | float]) -> str:
    parsed = urllib_parse.urlsplit(url)
    current_query = dict(urllib_parse.parse_qsl(parsed.query, keep_blank_values=True))
    for key, value in params.items():
        current_query[key] = str(value)
    updated_query = urllib_parse.urlencode(current_query)
    return urllib_parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, updated_query, parsed.fragment))


def _oauth_error_redirect(mobile_redirect_uri: str, message: str) -> RedirectResponse:
    return RedirectResponse(url=_append_query_to_url(mobile_redirect_uri, {"error": message}), status_code=302)


def _http_post_form_json(url: str, payload: dict[str, str]) -> dict[str, object]:
    body = urllib_parse.urlencode(payload).encode("utf-8")
    req = urllib_request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=15) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=400, detail=f"OAuth token exchange failed: {detail or exc.reason}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OAuth token exchange failed: {exc}") from exc

    try:
        parsed = json.loads(raw) if raw else {}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OAuth token response parse failed: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=500, detail="OAuth token response is invalid")
    return parsed


def _http_get_json(url: str, headers: dict[str, str] | None = None) -> dict[str, object]:
    req = urllib_request.Request(url, headers=headers or {"Accept": "application/json"}, method="GET")
    try:
        with urllib_request.urlopen(req, timeout=15) as response:
            raw = response.read().decode("utf-8")
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise HTTPException(status_code=400, detail=f"OAuth profile fetch failed: {detail or exc.reason}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OAuth profile fetch failed: {exc}") from exc

    try:
        parsed = json.loads(raw) if raw else {}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"OAuth profile response parse failed: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=500, detail="OAuth profile response is invalid")
    return parsed


def _google_profile(settings: Settings, code: str, callback_url: str) -> tuple[str, str | None, str | None]:
    client_id, client_secret = _oauth_client_config(settings, "google")
    token_data = _http_post_form_json(
        "https://oauth2.googleapis.com/token",
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": callback_url,
            "grant_type": "authorization_code",
        },
    )
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        raise HTTPException(status_code=400, detail="Google access token is missing")

    profile = _http_get_json(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    provider_user_id = str(profile.get("sub") or "").strip()
    if not provider_user_id:
        raise HTTPException(status_code=400, detail="Google user id is missing")
    email = str(profile.get("email") or "").strip() or None
    display_name = str(profile.get("name") or profile.get("given_name") or "").strip() or None
    return provider_user_id, email, display_name


def _kakao_profile(settings: Settings, code: str, callback_url: str) -> tuple[str, str | None, str | None]:
    client_id, client_secret = _oauth_client_config(settings, "kakao")
    payload = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "redirect_uri": callback_url,
        "code": code,
    }
    if client_secret:
        payload["client_secret"] = client_secret
    token_data = _http_post_form_json("https://kauth.kakao.com/oauth/token", payload)
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        raise HTTPException(status_code=400, detail="Kakao access token is missing")

    profile = _http_get_json(
        "https://kapi.kakao.com/v2/user/me",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    provider_user_id = str(profile.get("id") or "").strip()
    if not provider_user_id:
        raise HTTPException(status_code=400, detail="Kakao user id is missing")

    account = profile.get("kakao_account") if isinstance(profile.get("kakao_account"), dict) else {}
    properties = profile.get("properties") if isinstance(profile.get("properties"), dict) else {}
    email = str(account.get("email") or "").strip() or None
    display_name = str(properties.get("nickname") or "").strip() or None
    return provider_user_id, email, display_name


def _naver_profile(settings: Settings, code: str, state: str) -> tuple[str, str | None, str | None]:
    client_id, client_secret = _oauth_client_config(settings, "naver")
    token_query = urllib_parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "state": state,
        }
    )
    token_data = _http_get_json(f"https://nid.naver.com/oauth2.0/token?{token_query}")
    access_token = str(token_data.get("access_token") or "").strip()
    if not access_token:
        raise HTTPException(status_code=400, detail="Naver access token is missing")

    profile = _http_get_json(
        "https://openapi.naver.com/v1/nid/me",
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    response_data = profile.get("response") if isinstance(profile.get("response"), dict) else {}
    provider_user_id = str(response_data.get("id") or "").strip()
    if not provider_user_id:
        raise HTTPException(status_code=400, detail="Naver user id is missing")
    email = str(response_data.get("email") or "").strip() or None
    display_name = str(response_data.get("name") or response_data.get("nickname") or "").strip() or None
    return provider_user_id, email, display_name


@app.post("/api/auth/register", response_model=AuthSessionResponse)
def register_auth(
    body: AuthRegisterRequest,
    settings: Settings = Depends(get_settings),
) -> AuthSessionResponse:
    try:
        store = _get_auth_store(settings)
        user = store.create_user(body.email, body.password, body.display_name)
        token, expires_at = store.create_session(user["id"])
        return _build_auth_session_response(user, token, expires_at)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Registration failed: {exc}") from exc


@app.post("/api/auth/login", response_model=AuthSessionResponse)
def login_auth(
    body: AuthLoginRequest,
    settings: Settings = Depends(get_settings),
) -> AuthSessionResponse:
    try:
        store = _get_auth_store(settings)
        user = store.authenticate(body.email, body.password)
        if user is None:
            raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다.")
        token, expires_at = store.create_session(user["id"])
        return _build_auth_session_response(user, token, expires_at)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Login failed: {exc}") from exc


@app.get("/api/auth/me", response_model=AuthUser)
def me_auth(current_user: dict[str, str] = Depends(_require_user)) -> AuthUser:
    return AuthUser(
        id=current_user["id"],
        email=current_user["email"],
        display_name=current_user["display_name"],
    )


@app.post("/api/auth/logout")
def logout_auth(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    token = _extract_bearer_token(authorization)
    if token:
        _get_auth_store(settings).invalidate_session(token)
    return {"status": "ok"}


@app.get("/api/auth/oauth/{provider}/start")
def oauth_start(
    provider: str,
    request: Request,
    mobile_redirect_uri: str | None = Query(default=None),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    selected_provider = _normalize_oauth_provider(provider)
    client_id, _ = _oauth_client_config(settings, selected_provider)
    redirect_uri = (mobile_redirect_uri or settings.auth_mobile_redirect_uri).strip()
    if not redirect_uri:
        raise HTTPException(status_code=400, detail="mobile_redirect_uri is required")

    store = _get_auth_store(settings)
    oauth_state = store.create_oauth_state(selected_provider, redirect_uri)
    callback_url = _build_oauth_callback_url(settings, request, selected_provider)

    if selected_provider == "google":
        params = {
            "client_id": client_id,
            "redirect_uri": callback_url,
            "response_type": "code",
            "scope": "openid email profile",
            "state": oauth_state,
            "prompt": "select_account",
        }
        auth_url = f"https://accounts.google.com/o/oauth2/v2/auth?{urllib_parse.urlencode(params)}"
    elif selected_provider == "kakao":
        params = {
            "client_id": client_id,
            "redirect_uri": callback_url,
            "response_type": "code",
            "state": oauth_state,
        }
        auth_url = f"https://kauth.kakao.com/oauth/authorize?{urllib_parse.urlencode(params)}"
    else:
        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": callback_url,
            "state": oauth_state,
        }
        auth_url = f"https://nid.naver.com/oauth2.0/authorize?{urllib_parse.urlencode(params)}"

    return RedirectResponse(url=auth_url, status_code=302)


@app.get("/api/auth/oauth/{provider}/callback")
def oauth_callback(
    provider: str,
    request: Request,
    code: str | None = Query(default=None),
    state: str | None = Query(default=None),
    error: str | None = Query(default=None),
    settings: Settings = Depends(get_settings),
) -> RedirectResponse:
    selected_provider = _normalize_oauth_provider(provider)
    store = _get_auth_store(settings)
    mobile_redirect_uri = store.consume_oauth_state(state or "", selected_provider)
    if not mobile_redirect_uri:
        raise HTTPException(status_code=400, detail="OAuth state is invalid or expired")

    if error:
        return _oauth_error_redirect(mobile_redirect_uri, f"{selected_provider} login failed: {error}")
    if not code:
        return _oauth_error_redirect(mobile_redirect_uri, "OAuth code is missing")

    callback_url = _build_oauth_callback_url(settings, request, selected_provider)
    try:
        if selected_provider == "google":
            provider_user_id, email, display_name = _google_profile(settings, code, callback_url)
        elif selected_provider == "kakao":
            provider_user_id, email, display_name = _kakao_profile(settings, code, callback_url)
        else:
            provider_user_id, email, display_name = _naver_profile(settings, code, state or "")

        user = store.find_or_create_social_user(selected_provider, provider_user_id, email, display_name)
        access_token, expires_at = store.create_session(user["id"])
        return RedirectResponse(
            url=_append_query_to_url(
                mobile_redirect_uri,
                {
                    "access_token": access_token,
                    "expires_at": str(expires_at),
                    "provider": selected_provider,
                },
            ),
            status_code=302,
        )
    except HTTPException as exc:
        return _oauth_error_redirect(mobile_redirect_uri, str(exc.detail))
    except Exception as exc:
        return _oauth_error_redirect(mobile_redirect_uri, f"OAuth login failed: {exc}")


@app.post("/api/transcribe", response_model=TranscriptionResponse)
def transcribe_audio(
    file: UploadFile = File(...),
    _: None = Depends(_require_api_key),
) -> TranscriptionResponse:
    tmp_path = _save_upload_to_temp(file)
    try:
        service = OpenAIService()
        transcript = service.transcribe_file(tmp_path)
        return TranscriptionResponse(transcript=transcript)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        file.file.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/transcribe-chat", response_model=TranscriptionResponse)
def transcribe_audio_with_chat(
    file: UploadFile = File(...),
    _: None = Depends(_require_api_key),
) -> TranscriptionResponse:
    tmp_path = _save_upload_to_temp(file)
    try:
        service = OpenAIService()
        transcript = service.transcribe_with_chat(tmp_path)
        return TranscriptionResponse(transcript=transcript)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat transcription failed: {exc}") from exc
    finally:
        file.file.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/summarize", response_model=SummarizeResponse)
def summarize_text(
    body: SummarizeRequest,
    _: None = Depends(_require_api_key),
) -> SummarizeResponse:
    try:
        service = OpenAIService()
        summary = service.summarize_transcript(body.transcript)
        return SummarizeResponse(summary=summary)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Summarization failed: {exc}") from exc


@app.post("/api/summarize-chat", response_model=SummarizeResponse)
def summarize_text_with_chat(
    body: SummarizeRequest,
    _: None = Depends(_require_api_key),
) -> SummarizeResponse:
    try:
        service = OpenAIService()
        summary = service.summarize_with_chat(body.transcript)
        return SummarizeResponse(summary=summary)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat summarization failed: {exc}") from exc


@app.post("/api/translate", response_model=TranslateResponse)
def translate_text(
    body: TranslateRequest,
    _: None = Depends(_require_api_key),
) -> TranslateResponse:
    try:
        service = OpenAIService()
        translated = service.translate_text(body.text, body.target_language)
        return TranslateResponse(translation=translated)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Translation failed: {exc}") from exc


@app.post("/api/translate-chat", response_model=TranslateResponse)
def translate_text_with_chat(
    body: TranslateRequest,
    _: None = Depends(_require_api_key),
) -> TranslateResponse:
    try:
        service = OpenAIService()
        translated = service.translate_with_chat(body.text, body.target_language)
        return TranslateResponse(translation=translated)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Chat translation failed: {exc}") from exc


@app.post("/api/process", response_model=ProcessResponse)
def process_audio(
    file: UploadFile = File(...),
    _: None = Depends(_require_api_key),
) -> ProcessResponse:
    tmp_path = _save_upload_to_temp(file)
    try:
        service = OpenAIService()
        transcript = service.transcribe_file(tmp_path)
        summary = service.summarize_transcript(transcript)
        return ProcessResponse(transcript=transcript, summary=summary)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Processing failed: {exc}") from exc
    finally:
        file.file.close()
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/jobs/transcribe", response_model=JobCreateResponse)
def create_transcribe_job(
    file: UploadFile = File(...),
    mode: str = Form(default="chat"),
    file_name: str = Form(default=""),
    expo_push_token: str | None = Form(default=None),
    _: None = Depends(_require_api_key),
) -> JobCreateResponse:
    selected_mode = (mode or "chat").strip().lower()
    if selected_mode not in {"api", "chat"}:
        raise HTTPException(status_code=400, detail="mode must be one of: api, chat")

    tmp_path = _save_upload_to_temp(file)
    display_name = (file_name or file.filename or Path(tmp_path).name).strip()
    job = _create_job("transcribe", selected_mode, display_name, expo_push_token)
    job_id = str(job["job_id"])

    try:
        JOB_EXECUTOR.submit(_run_transcribe_job, job_id, tmp_path, selected_mode, display_name, expo_push_token)
    except Exception as exc:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{display_name} 전사 실패")
        raise HTTPException(status_code=500, detail=f"Failed to enqueue transcription job: {exc}") from exc
    finally:
        file.file.close()

    return JobCreateResponse(job_id=job_id, status="queued", job_type="transcribe", message=f"{display_name} 전사중")


@app.post("/api/jobs/summarize", response_model=JobCreateResponse)
def create_summarize_job(
    body: AsyncSummarizeRequest,
    _: None = Depends(_require_api_key),
) -> JobCreateResponse:
    selected_mode = (body.mode or "chat").strip().lower()
    if selected_mode not in {"api", "chat"}:
        raise HTTPException(status_code=400, detail="mode must be one of: api, chat")

    display_name = (body.file_name or "선택 파일").strip()
    job = _create_job("summarize", selected_mode, display_name, body.expo_push_token)
    job_id = str(job["job_id"])

    try:
        JOB_EXECUTOR.submit(_run_summarize_job, job_id, body.transcript, selected_mode, display_name, body.expo_push_token)
    except Exception as exc:
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{display_name} 요약 실패")
        raise HTTPException(status_code=500, detail=f"Failed to enqueue summarize job: {exc}") from exc

    return JobCreateResponse(job_id=job_id, status="queued", job_type="summarize", message=f"{display_name} 요약중")


@app.post("/api/jobs/translate", response_model=JobCreateResponse)
def create_translate_job(
    body: AsyncTranslateRequest,
    _: None = Depends(_require_api_key),
) -> JobCreateResponse:
    selected_mode = (body.mode or "chat").strip().lower()
    if selected_mode not in {"api", "chat"}:
        raise HTTPException(status_code=400, detail="mode must be one of: api, chat")

    display_name = (body.file_name or "selected-file").strip()
    job = _create_job("translate", selected_mode, display_name, body.expo_push_token)
    job_id = str(job["job_id"])

    try:
        JOB_EXECUTOR.submit(
            _run_translate_job,
            job_id,
            body.text,
            body.target_language,
            selected_mode,
            display_name,
            body.expo_push_token,
        )
    except Exception as exc:
        _update_job(job_id, status="failed", error=f"{exc}", message=f"{display_name} 번역 실패")
        raise HTTPException(status_code=500, detail=f"Failed to enqueue translate job: {exc}") from exc

    return JobCreateResponse(job_id=job_id, status="queued", job_type="translate", message=f"{display_name} 번역중")


@app.get("/api/jobs/{job_id}", response_model=JobStatusResponse)
def get_job_status(job_id: str, _: None = Depends(_require_api_key)) -> JobStatusResponse:
    job = _get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    return JobStatusResponse(
        job_id=str(job.get("job_id") or job_id),
        status=str(job.get("status") or "unknown"),
        job_type=str(job.get("job_type") or "unknown"),
        mode=str(job.get("mode") or "unknown"),
        file_name=str(job.get("file_name") or "unknown"),
        message=str(job.get("message") or ""),
        transcript=job.get("transcript") if isinstance(job.get("transcript"), str) else None,
        translation=job.get("translation") if isinstance(job.get("translation"), str) else None,
        summary=job.get("summary") if isinstance(job.get("summary"), str) else None,
        error=job.get("error") if isinstance(job.get("error"), str) else None,
        created_at=float(job.get("created_at") or _now_ts()),
        updated_at=float(job.get("updated_at") or _now_ts()),
    )


@app.post("/api/library/sync", response_model=LibrarySyncResponse)
def sync_subject_files_to_library(
    subject_id: str = Form(...),
    subject_name: str = Form(...),
    subject_tag: str | None = Form(default=None),
    subject_icon: str | None = Form(default=None),
    subject_color: str | None = Form(default=None),
    recording_name: str | None = Form(default=None),
    transcript_name: str | None = Form(default=None),
    translation_name: str | None = Form(default=None),
    summary_name: str | None = Form(default=None),
    recording: UploadFile | None = File(default=None),
    transcript: UploadFile | None = File(default=None),
    translation: UploadFile | None = File(default=None),
    summary: UploadFile | None = File(default=None),
    settings: Settings = Depends(get_settings),
    current_user: dict[str, str] = Depends(_require_user),
) -> LibrarySyncResponse:
    target_dir = _subject_library_dir(settings, subject_id, subject_name, current_user["id"])
    saved_files: list[str] = []

    try:
        if recording is not None:
            file_name = _safe_file_name(recording_name or recording.filename or "recording.m4a", "recording.m4a")
            recording_target = _subject_data_dir(target_dir, "recording") / file_name
            _copy_upload_to(recording, recording_target)
            saved_files.append(f"recordings/{file_name}")
        if transcript is not None:
            file_name = _safe_file_name(transcript_name or transcript.filename or "transcript.txt", "transcript.txt")
            transcript_target = _subject_data_dir(target_dir, "transcript") / file_name
            _copy_upload_to(transcript, transcript_target)
            saved_files.append(f"transcripts/{file_name}")
        if translation is not None:
            file_name = _safe_file_name(translation_name or translation.filename or "translation.txt", "translation.txt")
            translation_target = _subject_data_dir(target_dir, "translation") / file_name
            _copy_upload_to(translation, translation_target)
            saved_files.append(f"translations/{file_name}")
        if summary is not None:
            file_name = _safe_file_name(summary_name or summary.filename or "summary.txt", "summary.txt")
            summary_target = _subject_data_dir(target_dir, "summary") / file_name
            _copy_upload_to(summary, summary_target)
            saved_files.append(f"summaries/{file_name}")

        meta = _load_subject_meta(target_dir)
        if not meta.get("created_at"):
            meta["created_at"] = _now_ts()
        meta.update(
            {
                "id": subject_id,
                "name": subject_name,
                "tag": subject_tag or "",
                "icon": subject_icon or meta.get("icon") or "",
                "color": subject_color or meta.get("color") or "",
                "updated_at": _now_ts(),
            }
        )
        _save_subject_meta(target_dir, meta)

        return LibrarySyncResponse(
            subject_id=subject_id,
            subject_name=subject_name,
            target_dir=str(target_dir.resolve()),
            saved_files=saved_files,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Library sync failed: {exc}") from exc
    finally:
        if recording is not None:
            recording.file.close()
        if transcript is not None:
            transcript.file.close()
        if translation is not None:
            translation.file.close()
        if summary is not None:
            summary.file.close()


@app.get("/api/library")
def list_library(
    settings: Settings = Depends(get_settings),
    current_user: dict[str, str] = Depends(_require_user),
) -> dict[str, object]:
    root = _resolve_library_root(settings, current_user["id"])
    subjects: list[dict[str, object]] = []

    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        recordings_dir = entry / "recordings"
        transcripts_dir = entry / "transcripts"
        translations_dir = entry / "translations"
        summaries_dir = entry / "summaries"
        meta = _load_subject_meta(entry)

        recordings = sorted([p.name for p in recordings_dir.iterdir() if p.is_file()]) if recordings_dir.exists() else []
        transcripts = (
            sorted([p.name for p in transcripts_dir.iterdir() if p.is_file()]) if transcripts_dir.exists() else []
        )
        translations = (
            sorted([p.name for p in translations_dir.iterdir() if p.is_file()]) if translations_dir.exists() else []
        )
        summaries = sorted([p.name for p in summaries_dir.iterdir() if p.is_file()]) if summaries_dir.exists() else []
        subject_id = str(meta.get("id") or entry.name.split("__")[-1])
        subject_name = str(meta.get("name") or subject_id)
        subjects.append(
            {
                "folder": entry.name,
                "path": str(entry.resolve()),
                "subject_id": subject_id,
                "subject_name": subject_name,
                "subject_tag": str(meta.get("tag") or ""),
                "subject_icon": str(meta.get("icon") or ""),
                "subject_color": str(meta.get("color") or ""),
                "recording": len(recordings) > 0,
                "transcript": len(transcripts) > 0,
                "translation": len(translations) > 0,
                "summary": len(summaries) > 0,
                "recordings": recordings,
                "transcripts": transcripts,
                "translations": translations,
                "summaries": summaries,
            }
        )

    return {"root_dir": str(root.resolve()), "subjects": subjects}


@app.get("/api/library/file")
def download_library_file(
    subject_id: str = Query(...),
    kind: str = Query(...),
    name: str = Query(...),
    settings: Settings = Depends(get_settings),
    current_user: dict[str, str] = Depends(_require_user),
) -> FileResponse:
    target = _resolve_library_file(settings, current_user["id"], subject_id, kind, name)
    return FileResponse(path=str(target), filename=target.name, media_type="application/octet-stream")
