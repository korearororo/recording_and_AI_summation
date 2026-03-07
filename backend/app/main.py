from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.schemas import ProcessResponse, SummarizeRequest, SummarizeResponse, TranscriptionResponse
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
