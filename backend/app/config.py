from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    transcribe_model: str = Field(default="gpt-4o-mini-transcribe", alias="TRANSCRIBE_MODEL")
    summary_model: str = Field(default="gpt-4.1-mini", alias="SUMMARY_MODEL")
    chat_transcribe_model: str = Field(default="gpt-4.1-mini", alias="CHAT_TRANSCRIBE_MODEL")
    chat_summary_model: str = Field(default="gpt-4.1-mini", alias="CHAT_SUMMARY_MODEL")
    transcribe_max_file_mb: int = Field(default=24, alias="TRANSCRIBE_MAX_FILE_MB")
    transcribe_chunk_minutes: int = Field(default=10, alias="TRANSCRIBE_CHUNK_MINUTES")
    transcribe_chunk_bitrate: str = Field(default="64k", alias="TRANSCRIBE_CHUNK_BITRATE")
    transcribe_parallel_chunks: int = Field(default=3, alias="TRANSCRIBE_PARALLEL_CHUNKS")
    openai_timeout_seconds: float = Field(default=300, alias="OPENAI_TIMEOUT_SECONDS")
    openai_max_retries: int = Field(default=1, alias="OPENAI_MAX_RETRIES")
    allowed_origins: str = Field(default="*", alias="ALLOWED_ORIGINS")
    library_root: str = Field(default="library", alias="LIBRARY_ROOT")
    auth_db_path: str = Field(default="auth/auth.db", alias="AUTH_DB_PATH")
    auth_session_hours: int = Field(default=24 * 30, alias="AUTH_SESSION_HOURS")

    @property
    def allowed_origins_list(self) -> List[str]:
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
