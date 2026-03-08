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
from urllib import request as urllib_request

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from app.config import Settings, get_settings
from app.schemas import (
    AsyncSummarizeRequest,
    JobCreateResponse,
    JobStatusResponse,
    LibrarySyncResponse,
    ProcessResponse,
    SummarizeRequest,
    SummarizeResponse,
    TranscriptionResponse,
)
from app.services.openai_service import OpenAIService

app = FastAPI(title="Recording & AI Summary API", version="0.1.0")

JOB_EXECUTOR = ThreadPoolExecutor(max_workers=2)
JOB_LOCK = Lock()
JOBS: dict[str, dict[str, object]] = {}


def _configure_cors(settings: Settings) -> None:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


_configure_cors(get_settings())


def _require_api_key(settings: Settings = Depends(get_settings)) -> None:
    if not settings.openai_api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is missing")


def _save_upload_to_temp(upload: UploadFile) -> str:
    extension = Path(upload.filename or "recording.m4a").suffix or ".m4a"
    with tempfile.NamedTemporaryFile(delete=False, suffix=extension) as temp_file:
        shutil.copyfileobj(upload.file, temp_file)
        return temp_file.name


def _resolve_library_root(settings: Settings) -> Path:
    root = Path(settings.library_root)
    if not root.is_absolute():
        root = Path(__file__).resolve().parents[1] / root
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


def _subject_library_dir(settings: Settings, subject_id: str, subject_name: str) -> Path:
    root = _resolve_library_root(settings)
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
        "summary": target_dir / "summaries",
    }
    if kind not in mapping:
        raise HTTPException(status_code=400, detail="kind must be one of: recording, transcript, summary")
    data_dir = mapping[kind]
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def _resolve_library_file(settings: Settings, subject_id: str, kind: str, name: str) -> Path:
    root = _resolve_library_root(settings)
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
        "summary": None,
        "error": None,
        "expo_push_token": expo_push_token or "",
        "created_at": now,
        "updated_at": now,
    }
    with JOB_LOCK:
        JOBS[job_id] = record
    return record


def _update_job(job_id: str, **kwargs: object) -> None:
    with JOB_LOCK:
        item = JOBS.get(job_id)
        if item is None:
            return
        item.update(kwargs)
        item["updated_at"] = _now_ts()


def _get_job(job_id: str) -> dict[str, object] | None:
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


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


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
    summary_name: str | None = Form(default=None),
    recording: UploadFile | None = File(default=None),
    transcript: UploadFile | None = File(default=None),
    summary: UploadFile | None = File(default=None),
    settings: Settings = Depends(get_settings),
) -> LibrarySyncResponse:
    target_dir = _subject_library_dir(settings, subject_id, subject_name)
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
        if summary is not None:
            summary.file.close()


@app.get("/api/library")
def list_library(settings: Settings = Depends(get_settings)) -> dict[str, object]:
    root = _resolve_library_root(settings)
    subjects: list[dict[str, object]] = []

    for entry in sorted(root.iterdir()):
        if not entry.is_dir():
            continue
        recordings_dir = entry / "recordings"
        transcripts_dir = entry / "transcripts"
        summaries_dir = entry / "summaries"
        meta = _load_subject_meta(entry)

        recordings = sorted([p.name for p in recordings_dir.iterdir() if p.is_file()]) if recordings_dir.exists() else []
        transcripts = (
            sorted([p.name for p in transcripts_dir.iterdir() if p.is_file()]) if transcripts_dir.exists() else []
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
                "summary": len(summaries) > 0,
                "recordings": recordings,
                "transcripts": transcripts,
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
) -> FileResponse:
    target = _resolve_library_file(settings, subject_id, kind, name)
    return FileResponse(path=str(target), filename=target.name, media_type="application/octet-stream")
