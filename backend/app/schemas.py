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


class AuthUser(BaseModel):
    id: str
    email: str
    display_name: str


class AuthRegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=256)
    display_name: str | None = Field(default=None, max_length=80)


class AuthLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=255)
    password: str = Field(min_length=6, max_length=256)


class AuthSessionResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_at: float
    user: AuthUser
