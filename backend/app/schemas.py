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
