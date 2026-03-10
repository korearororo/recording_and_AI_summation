from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    openai_api_key: str = Field(default="", alias="OPENAI_API_KEY")
    transcribe_model: str = Field(default="gpt-4o-mini-transcribe", alias="TRANSCRIBE_MODEL")
    summary_model: str = Field(default="gpt-4.1-mini", alias="SUMMARY_MODEL")
    translation_model: str = Field(default="gpt-4.1-mini", alias="TRANSLATION_MODEL")
    chat_transcribe_model: str = Field(default="gpt-4.1-mini", alias="CHAT_TRANSCRIBE_MODEL")
    chat_translation_model: str = Field(default="gpt-4.1-mini", alias="CHAT_TRANSLATION_MODEL")
    chat_summary_model: str = Field(default="gpt-4.1-mini", alias="CHAT_SUMMARY_MODEL")
    transcribe_max_file_mb: int = Field(default=24, alias="TRANSCRIBE_MAX_FILE_MB")
    transcribe_chunk_minutes: int = Field(default=5, alias="TRANSCRIBE_CHUNK_MINUTES")
    transcribe_chunk_bitrate: str = Field(default="64k", alias="TRANSCRIBE_CHUNK_BITRATE")
    transcribe_parallel_chunks: int = Field(default=3, alias="TRANSCRIBE_PARALLEL_CHUNKS")
    transcribe_force_chunking: bool = Field(default=True, alias="TRANSCRIBE_FORCE_CHUNKING")
    openai_timeout_seconds: float = Field(default=300, alias="OPENAI_TIMEOUT_SECONDS")
    openai_max_retries: int = Field(default=1, alias="OPENAI_MAX_RETRIES")
    allowed_origins: str = Field(default="*", alias="ALLOWED_ORIGINS")
    library_root: str = Field(default="library", alias="LIBRARY_ROOT")
    google_drive_enabled: bool = Field(default=False, alias="GOOGLE_DRIVE_ENABLED")
    google_drive_service_account_json: str = Field(default="", alias="GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON")
    google_drive_root_folder_id: str = Field(default="", alias="GOOGLE_DRIVE_ROOT_FOLDER_ID")
    google_drive_oauth_client_id: str = Field(default="", alias="GOOGLE_DRIVE_OAUTH_CLIENT_ID")
    google_drive_oauth_client_secret: str = Field(default="", alias="GOOGLE_DRIVE_OAUTH_CLIENT_SECRET")
    google_drive_oauth_refresh_token: str = Field(default="", alias="GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN")
    job_store_path: str = Field(default="jobs/jobs.json", alias="JOB_STORE_PATH")
    job_store_max_items: int = Field(default=1000, alias="JOB_STORE_MAX_ITEMS")
    auth_database_url: str = Field(default="", alias="AUTH_DATABASE_URL")
    auth_db_path: str = Field(default="auth/auth.db", alias="AUTH_DB_PATH")
    auth_session_hours: int = Field(default=24 * 30, alias="AUTH_SESSION_HOURS")
    auth_public_base_url: str = Field(default="", alias="AUTH_PUBLIC_BASE_URL")
    auth_mobile_redirect_uri: str = Field(default="meetingnoteai://auth/callback", alias="AUTH_MOBILE_REDIRECT_URI")
    google_client_id: str = Field(default="", alias="GOOGLE_CLIENT_ID")
    google_client_secret: str = Field(default="", alias="GOOGLE_CLIENT_SECRET")
    kakao_client_id: str = Field(default="", alias="KAKAO_CLIENT_ID")
    kakao_client_secret: str = Field(default="", alias="KAKAO_CLIENT_SECRET")
    naver_client_id: str = Field(default="", alias="NAVER_CLIENT_ID")
    naver_client_secret: str = Field(default="", alias="NAVER_CLIENT_SECRET")

    @property
    def allowed_origins_list(self) -> List[str]:
        if self.allowed_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
