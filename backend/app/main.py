from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.schemas import (
    LibrarySyncResponse,
    ProcessResponse,
    SummarizeRequest,
    SummarizeResponse,
    TranscriptionResponse,
)
from app.services.openai_service import OpenAIService

app = FastAPI(title="Recording & AI Summary API", version="0.1.0")


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


def _subject_library_dir(settings: Settings, subject_id: str, subject_name: str) -> Path:
    root = _resolve_library_root(settings)
    folder_name = f"{_safe_segment(subject_name)}__{_safe_segment(subject_id)}"
    target = root / folder_name
    target.mkdir(parents=True, exist_ok=True)
    return target


def _copy_upload_to(upload: UploadFile, target_path: Path) -> None:
    with target_path.open("wb") as out_file:
        shutil.copyfileobj(upload.file, out_file)


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


@app.post("/api/library/sync", response_model=LibrarySyncResponse)
def sync_subject_files_to_library(
    subject_id: str = Form(...),
    subject_name: str = Form(...),
    subject_tag: str | None = Form(default=None),
    recording: UploadFile | None = File(default=None),
    transcript: UploadFile | None = File(default=None),
    summary: UploadFile | None = File(default=None),
    settings: Settings = Depends(get_settings),
) -> LibrarySyncResponse:
    target_dir = _subject_library_dir(settings, subject_id, subject_name)
    saved_files: list[str] = []

    try:
        if recording is not None:
            _copy_upload_to(recording, target_dir / "recording.m4a")
            saved_files.append("recording.m4a")
        if transcript is not None:
            _copy_upload_to(transcript, target_dir / "transcript.txt")
            saved_files.append("transcript.txt")
        if summary is not None:
            _copy_upload_to(summary, target_dir / "summary.txt")
            saved_files.append("summary.txt")

        meta = {
            "id": subject_id,
            "name": subject_name,
            "tag": subject_tag or "",
            "saved_files": saved_files,
        }
        (target_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

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
        subjects.append(
            {
                "folder": entry.name,
                "path": str(entry.resolve()),
                "recording": (entry / "recording.m4a").exists(),
                "transcript": (entry / "transcript.txt").exists(),
                "summary": (entry / "summary.txt").exists(),
            }
        )

    return {"root_dir": str(root.resolve()), "subjects": subjects}
