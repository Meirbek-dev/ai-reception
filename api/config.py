from __future__ import annotations

import os
from pathlib import Path

from pydantic import ConfigDict, Field, field_validator, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings with validation."""

    environment: str = Field(default="development")
    max_file_size: int = Field(default=50 * 1024 * 1024, gt=0)
    max_workers: int = Field(default=min(8, os.cpu_count() or 1), gt=0)
    max_tasks_per_child: int = Field(default=100, gt=0)
    upload_chunk_size: int = Field(default=64 * 1024, gt=0, le=4 * 1024 * 1024)
    upload_folder: Path = Field(default=Path("uploads"))
    cache_folder: Path = Field(default=Path("cache"))
    web_build_folder: Path = Field(default=Path("build/web"))
    max_pages_ocr: int = Field(default=10, gt=0, le=50)
    image_max_size: int = Field(default=1800, gt=0)
    log_level: str = Field(default="INFO")
    max_file_age_days: int = Field(default=30, gt=0)
    cache_ttl_days: int = Field(default=7, gt=0)
    cleanup_interval_seconds: int = Field(default=3600, gt=0)
    rate_limit_per_minute: int = Field(default=30, gt=0)
    max_files_per_upload: int = Field(default=20, gt=0)
    max_text_extract_length: int = Field(default=5000, gt=0)
    tesseract_timeout: int = Field(default=30, gt=0)
    tesseract_psm: int = Field(default=4, ge=0, le=13)
    pdf_dpi: int = Field(default=200, gt=0, le=300)
    pdf_parallel_pages: int = Field(default=8, gt=0, le=16)
    database_url: str = Field(default="sqlite+aiosqlite:///./data/ai_reception.db")
    # Session/Auth settings
    session_secret_key: str = Field(
        default="CHANGE_ME_IN_PRODUCTION_USE_LONG_RANDOM_STRING"
    )
    session_cookie_name: str = Field(default="ai_reception_session")
    session_max_age: int = Field(default=86400, gt=0)  # 24 hours in seconds
    session_remember_max_age: int = Field(default=86400 * 30, gt=0)
    session_refresh_lead_time: int = Field(default=300, ge=60)

    model_config = ConfigDict(env_prefix="APP_", case_sensitive=False)

    @property
    def is_production(self) -> bool:
        """Check if running in production environment."""
        return self.environment.lower() in ("production", "prod")

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        valid = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        normalized = value.upper()
        if normalized not in valid:
            msg = f"log_level must be one of {valid}"
            raise ValueError(msg)
        return normalized

    @model_validator(mode="after")
    def apply_database_url(self) -> Settings:
        env_url = os.getenv("DATABASE_URL")
        if env_url:
            object.__setattr__(self, "database_url", env_url)
        if self.session_remember_max_age < self.session_max_age:
            msg = "session_remember_max_age must be greater than or equal to session_max_age"
            raise ValueError(msg)
        return self


settings = Settings()
