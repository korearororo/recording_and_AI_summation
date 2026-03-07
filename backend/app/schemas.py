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
