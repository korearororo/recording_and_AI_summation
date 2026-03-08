from typing import Literal

from pydantic import BaseModel, Field


class TranscriptionResponse(BaseModel):
    transcript: str


class SummarizeRequest(BaseModel):
    transcript: str = Field(min_length=1)


class SummarizeResponse(BaseModel):
    summary: str


class ProcessResponse(BaseModel):
    transcript: str
    summary: str


class LibrarySyncResponse(BaseModel):
    subject_id: str
    subject_name: str
    target_dir: str
    saved_files: list[str]


class AsyncSummarizeRequest(BaseModel):
    transcript: str = Field(min_length=1)
    mode: Literal["api", "chat"] = "chat"
    file_name: str | None = None
    expo_push_token: str | None = None


class JobCreateResponse(BaseModel):
    job_id: str
    status: str
    job_type: str
    message: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    job_type: str
    mode: str
    file_name: str
    message: str
    transcript: str | None = None
    summary: str | None = None
    error: str | None = None
    created_at: float
    updated_at: float
