"""
Modern OCR-based document classification with parallel processing
"""

import asyncio
import io
import logging
import os
import tempfile
import time
import uuid
import zipfile
from collections import defaultdict, deque
from collections.abc import AsyncGenerator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import aiofiles
import pytesseract
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pdf2image import convert_from_bytes
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_settings import BaseSettings
from rapidfuzz import fuzz

# ============================================================================
# CONFIGURATION
# ============================================================================


class Settings(BaseSettings):
    """Application settings with validation"""

    max_file_size: int = Field(default=50 * 1024 * 1024, gt=0)
    max_workers: int = Field(default=min(4, os.cpu_count() or 1), gt=0)
    upload_folder: Path = Field(default=Path("uploads"))
    web_build_folder: Path = Field(default=Path("build/web"))
    max_pages_ocr: int = Field(default=10, gt=0, le=50)
    image_max_size: int = Field(default=2000, gt=0)
    log_level: str = Field(default="INFO")
    max_file_age_days: int = Field(default=30, gt=0)
    cleanup_interval_seconds: int = Field(default=3600, gt=0)
    rate_limit_per_minute: int = Field(default=30, gt=0)
    max_files_per_upload: int = Field(default=20, gt=0)
    max_text_extract_length: int = Field(default=5000, gt=0)
    tesseract_timeout: int = Field(default=30, gt=0)

    model_config = ConfigDict(env_prefix="APP_", case_sensitive=False)

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, v: str) -> str:
        valid = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if v.upper() not in valid:
            msg = f"log_level must be one of {valid}"
            raise ValueError(msg)
        return v.upper()


settings = Settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


# ============================================================================
# MODELS & ENUMS
# ============================================================================


class DocumentCategory(str, Enum):
    """Document classification categories"""

    UDOSTOVERENIE = "Udostoverenie"
    ENT = "ENT"
    LGOTA = "Lgota"
    DIPLOM = "Diplom"
    PRIVIVKA = "Privivka"
    MED_SPRAVKA = "MedSpravka"
    UNCLASSIFIED = "Unclassified"


@dataclass(frozen=True)
class CategoryKeywords:
    """Immutable category keywords configuration"""

    UDOSTOVERENIE: tuple[str, ...] = ("удостоверение", "ID")
    ENT: tuple[str, ...] = (
        "сертификат",
        "ТЕСТИРОВАНИЯ",
        "ТЕСТІЛЕУ",
        "ТЕСТИРУЕМОГО",
        "Набранные баллы",
    )
    LGOTA: tuple[str, ...] = ("льгота", "инвалид", "многодетная")
    DIPLOM: tuple[str, ...] = ("диплом", "аттестат", "бакалавр", "магистр")
    PRIVIVKA: tuple[str, ...] = (
        "прививка",
        "прививочный паспорт",
        "вакцинирование",
        "инфекция",
    )
    MED_SPRAVKA: tuple[str, ...] = (
        "медицинская справка",
        "справка",
        "медицинский",
        "туберкулез",
        "полиомелит",
        "гепатит",
        "вич",
        "спид",
        "карта ребенка",
        "Дегельминтизация",
        "дегельминтизация",
        "клинический анализ крови",
        "анализ крови",
        "анализ мочи",
        "моча",
        "кровь",
        "флюорография",
        "флюорографическое обследование",
        "флюорография легких",
    )


KEYWORDS = CategoryKeywords()

CATEGORY_KEYWORDS = {
    DocumentCategory.UDOSTOVERENIE: KEYWORDS.UDOSTOVERENIE,
    DocumentCategory.ENT: KEYWORDS.ENT,
    DocumentCategory.LGOTA: KEYWORDS.LGOTA,
    DocumentCategory.DIPLOM: KEYWORDS.DIPLOM,
    DocumentCategory.PRIVIVKA: KEYWORDS.PRIVIVKA,
    DocumentCategory.MED_SPRAVKA: KEYWORDS.MED_SPRAVKA,
}

ALLOWED_EXTENSIONS = frozenset({".pdf", ".jpg", ".jpeg", ".png"})
ALLOWED_MIMETYPES = frozenset(
    {
        "application/pdf",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/pjpeg",
    }
)


class ProcessedFile(BaseModel):
    """Response model for processed files"""

    id: str
    original_name: str
    category: str
    filename: str
    size: int
    modified: int
    status: str


def processed_file_to_client(p: ProcessedFile) -> dict:
    """Convert internal ProcessedFile to a consistent client-facing JSON.

    This returns camelCase keys expected by the frontend and includes a
    stable `uid` which the frontend can use as a React key / selection id.
    """
    # Ensure uid is always a stable UUID-like string. Prefer backend id.
    uid = p.id if p.id else str(uuid.uuid4())

    return {
        "id": p.id,
        "originalName": p.original_name,
        # `newName` is the stored filename (human-facing saved name)
        "newName": p.filename or None,
        "filename": p.filename or None,
        "category": p.category,
        # keep some metadata handy for clients that want it
        "size": p.size,
        "modified": p.modified,
        "status": p.status,
        "uid": uid,
    }


class FileDeleteResponse(BaseModel):
    """Response model for file deletion"""

    status: str
    filename: str
    id: str | None = None
    original_name: str | None = None
    category: str | None = None
    size: int | None = None
    modified: int | None = None


class HealthCheck(BaseModel):
    """Health check response"""

    status: str
    version: str
    workers: int
    upload_folder_exists: bool



# ============================================================================
# RATE LIMITING
# ============================================================================


class RateLimiter:
    """Token bucket rate limiter with thread-safe operations"""

    def __init__(self, rate_per_minute: int, window_seconds: float = 60.0) -> None:
        self.rate = rate_per_minute
        self.window = window_seconds
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        self._lock = asyncio.Lock()

    async def is_limited(self, identifier: str) -> bool:
        """Check if identifier is rate limited"""
        async with self._lock:
            now = time.time()
            requests = self._requests[identifier]

            # Remove old requests outside window
            while requests and requests[0] < now - self.window:
                requests.popleft()

            if len(requests) >= self.rate:
                return True

            requests.append(now)
            return False

    async def cleanup_old_entries(self) -> None:
        """Remove expired rate limit entries"""
        async with self._lock:
            now = time.time()
            expired = [
                key
                for key, reqs in self._requests.items()
                if not reqs or reqs[-1] < now - self.window * 2
            ]
            for key in expired:
                del self._requests[key]


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================


def validate_file_extension(filename: str) -> bool:
    """Validate file extension"""
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def validate_mimetype(content_type: str | None) -> bool:
    """Validate MIME type"""
    if not content_type:
        return False
    return content_type.lower() in ALLOWED_MIMETYPES


def sanitize_name(name: str, max_length: int = 50) -> str:
    """Sanitize filename component with length limit"""
    if not name:
        return "anon"

    # Keep only alphanumeric, underscore, hyphen
    safe = "".join(c if (c.isalnum() or c in ("_", "-")) else "_" for c in name)

    # Collapse multiple underscores
    while "__" in safe:
        safe = safe.replace("__", "_")

    # Strip and truncate
    safe = safe.strip("_")[:max_length]

    return safe or "anon"


def optimize_image(img: Image.Image, max_size: int | None = None) -> Image.Image:
    """Optimize image for OCR with size constraints"""
    max_size = max_size or settings.image_max_size

    # Convert to RGB if necessary
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    # Resize if too large
    if max(img.size) > max_size:
        img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

    return img


def extract_text_from_image(img: Image.Image) -> str:
    """Extract text from a PIL Image using Tesseract"""
    try:
        optimized = optimize_image(img)
        config = "--psm 3 --oem 1"
        text = pytesseract.image_to_string(
            optimized, lang="rus", config=config, timeout=settings.tesseract_timeout
        )
        return text[: settings.max_text_extract_length]
    except pytesseract.TesseractError:
        logger.exception("Tesseract OCR failed")
        return ""
    except Exception:
        logger.exception("Image text extraction failed")
        return ""


def extract_text(file_bytes: bytes, ext: str) -> str:
    """Extract text from file bytes (PDF or image)"""
    try:
        if ext == ".pdf":
            return _extract_text_from_pdf(file_bytes)
        return _extract_text_from_image_bytes(file_bytes)
    except Exception:
        logger.exception("Text extraction failed for extension %s", ext)
        return ""


def _extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from PDF bytes"""
    try:
        images = convert_from_bytes(
            file_bytes,
            first_page=1,
            last_page=settings.max_pages_ocr,
            dpi=200,  # Better quality
        )

        texts = []
        total_length = 0

        for image in images:
            text = extract_text_from_image(image)
            texts.append(text)
            total_length += len(text)

            # Stop if we have enough text
            if total_length >= settings.max_text_extract_length:
                break

        return "\n".join(texts)[: settings.max_text_extract_length]
    except Exception:
        logger.exception("PDF text extraction failed")
        return ""


def _extract_text_from_image_bytes(file_bytes: bytes) -> str:
    """Extract text from image bytes"""
    try:
        img = Image.open(io.BytesIO(file_bytes))
        return extract_text_from_image(img)
    except UnidentifiedImageError:
        logger.exception("Unidentified image format")
        return ""
    except Exception:
        logger.exception("Image opening failed")
        return ""


@lru_cache(maxsize=512)
def classify_text(text: str) -> DocumentCategory:
    """Classify text using fuzzy matching (rapidfuzz) with caching.

    Returns UNCLASSIFIED when no keyword reaches the similarity threshold.
    """
    if not text:
        return DocumentCategory.UNCLASSIFIED

    text = text.strip()
    best_category = DocumentCategory.UNCLASSIFIED
    best_score = 0.0

    for category, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            try:
                score = fuzz.token_set_ratio(kw.lower(), text.lower())
            except Exception:
                score = 0.0
            if score > best_score:
                best_score = score
                best_category = category

    if best_score < 50:
        return DocumentCategory.UNCLASSIFIED

    return best_category


def parse_stored_filename(filename: str) -> dict[str, str] | None:
    """Parse metadata from stored filename format:
    {category}__{name}_{lastname}__{original}_{uuid}_{idx}{ext}

    Returns a dict with keys: id, category, name, original
    """
    parts = filename.split("__")
    # Expect at least 3 segments: category, name_lastname, rest
    if len(parts) < 3:
        return None

    category = parts[0]
    name = parts[1]

    # The remainder may contain original, uuid and index joined by underscores
    remainder = "__".join(parts[2:])
    stem = Path(remainder).stem

    # Try to split off the uuid (36-char UUID) which we expect near the end
    # Format we created: {original}_{uuid}_{idx}
    rev_parts = stem.rsplit("_", 2)
    if len(rev_parts) == 3:
        original, maybe_uuid, _ = rev_parts
        file_id = maybe_uuid if len(maybe_uuid) == 36 else ""
    elif len(rev_parts) == 2:
        original, maybe_uuid = rev_parts
        file_id = maybe_uuid if len(maybe_uuid) == 36 else ""
    else:
        original = stem
        file_id = ""

    return {
        "id": file_id,
        "category": category,
        "name": name,
        "original": original,
    }


async def write_atomic(dest: Path, data: bytes) -> None:
    """Write file atomically using temporary file"""
    dest.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_path_str = tempfile.mkstemp(
        dir=str(dest.parent), prefix=".tmp_", suffix=dest.suffix
    )
    os.close(fd)

    tmp_path = Path(tmp_path_str)
    try:
        async with aiofiles.open(tmp_path, "wb") as afp:
            await afp.write(data)
        tmp_path.replace(dest)
    finally:
        with suppress(Exception):
            tmp_path.unlink(missing_ok=True)


# ============================================================================
# FILE PROCESSING
# ============================================================================


async def save_upload_to_temp(upload_file: UploadFile) -> tuple[str, Path] | None:
    """Save uploaded file to temporary location with validation"""
    if not upload_file.filename:
        logger.warning("Upload file has no filename")
        return None

    if not validate_file_extension(upload_file.filename):
        logger.warning("Rejected extension: %s", upload_file.filename)
        return None

    if not validate_mimetype(upload_file.content_type):
        logger.warning(
            "Rejected content-type %s for %s",
            upload_file.content_type,
            upload_file.filename,
        )
        return None

    fd, tmp_path_str = tempfile.mkstemp(
        prefix="upload_", suffix=Path(upload_file.filename).suffix
    )
    os.close(fd)

    tmp_path = Path(tmp_path_str)
    total_size = 0
    try:
        async with aiofiles.open(tmp_path, "wb") as afp:
            while chunk := await upload_file.read(8192):
                total_size += len(chunk)
                if total_size > settings.max_file_size:
                    # cleanup and signal payload too large
                    tmp_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=(
                            f"File {upload_file.filename} exceeds "
                            f"{settings.max_file_size} bytes"
                        ),
                    )
                await afp.write(chunk)
    except HTTPException:
        # propagate HTTP errors raised above
        raise
    except OSError as exc:
        # filesystem/read/write errors
        tmp_path.unlink(missing_ok=True)
        logger.exception("Failed to save upload: %s", upload_file.filename)
        raise HTTPException(
            status_code=400,
            detail=f"Failed to save uploaded file: {upload_file.filename}",
        ) from exc
    else:
        # success
        return (upload_file.filename, tmp_path)


async def process_single_file(
    file_data: tuple[str, Path],
    name: str,
    lastname: str,
    executor: ThreadPoolExecutor,
) -> ProcessedFile | None:
    """Process a single uploaded file: OCR, classify, and store"""
    original_name, tmp_path = file_data
    ext = Path(original_name).suffix.lower()

    try:
        # Read file
        async with aiofiles.open(tmp_path, "rb") as afp:
            file_bytes = await afp.read()

        # Extract text in thread pool
        loop = asyncio.get_running_loop()
        text = await loop.run_in_executor(executor, extract_text, file_bytes, ext)

        # Classify
        category = classify_text(text)

        # Generate unique ID
        file_id = str(uuid.uuid4())
        size = len(file_bytes)
        modified = int(time.time())

        # Save if classified
        filename = ""
        status = "unclassified"

        if category != DocumentCategory.UNCLASSIFIED:
            # Format: {category}__{name}_{lastname}__{original}_{uuid}_{idx}{ext}
            base_name = (
                f"{category.value}__"
                f"{sanitize_name(name)}_{sanitize_name(lastname)}__"
                f"{sanitize_name(Path(original_name).stem)}"
            )

            # Find unique filename with uuid postfix and index
            idx = 1
            while True:
                candidate = f"{base_name}_{file_id}_{idx}{ext}"
                dest = settings.upload_folder / candidate
                if not dest.exists():
                    filename = candidate
                    await write_atomic(dest, file_bytes)
                    status = "saved"
                    logger.info("Saved file: %s as %s", original_name, category.value)
                    break
                idx += 1
                if idx > 1000:  # Safety limit
                    logger.error("Too many file collisions for %s", base_name)
                    break

        return ProcessedFile(
            id=file_id,
            original_name=original_name,
            category=category.value,
            filename=filename,
            size=size,
            modified=modified,
            status=status,
        )

    except Exception:
        logger.exception("Failed to process file: %s", original_name)
        return None

    finally:
        with suppress(Exception):
            tmp_path.unlink(missing_ok=True)


async def cleanup_old_files() -> int:
    """Remove files older than max_file_age_days"""
    if not settings.upload_folder.exists():
        return 0

    cutoff = time.time() - settings.max_file_age_days * 24 * 3600
    removed = 0

    for file_path in settings.upload_folder.iterdir():
        if not file_path.is_file():
            continue

        try:
            mtime = file_path.stat().st_mtime
            if mtime < cutoff:
                file_path.unlink()
                removed += 1
                logger.debug("Removed old file: %s", file_path.name)
        except OSError:
            logger.exception("Failed to check/remove file: %s", file_path)

    if removed:
        logger.info("Cleanup removed %d old files", removed)

    return removed


# ============================================================================
# FASTAPI APPLICATION
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Application lifespan: startup and shutdown"""
    # Startup
    settings.upload_folder.mkdir(parents=True, exist_ok=True)

    app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)
    app.state.executor = ThreadPoolExecutor(max_workers=settings.max_workers)

    # Background cleanup task
    async def cleanup_loop() -> None:
        while True:
            try:
                await asyncio.sleep(settings.cleanup_interval_seconds)
                await cleanup_old_files()
                await app.state.rate_limiter.cleanup_old_entries()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Cleanup loop error")

    app.state.cleanup_task = asyncio.create_task(cleanup_loop())
    logger.info("Application started")

    yield

    # Shutdown
    app.state.cleanup_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.cleanup_task

    app.state.executor.shutdown(wait=True)
    logger.info("Application shutdown complete")


app = FastAPI(
    title="AI Reception - Document Classification",
    description="OCR-based document classification system",
    version="2.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# API ENDPOINTS
# ============================================================================


@app.get("/health", response_model=HealthCheck)
async def health_check() -> HealthCheck:
    """Health check endpoint"""
    return HealthCheck(
        status="healthy",
        version="2.1.0",
        workers=settings.max_workers,
        upload_folder_exists=settings.upload_folder.exists(),
    )


@app.post("/upload")
async def upload_files(
    request: Request,
    background_tasks: BackgroundTasks,
    name: Annotated[str, Form(min_length=1, max_length=100)],
    lastname: Annotated[str, Form(min_length=1, max_length=100)],
    files: Annotated[list[UploadFile], File()],
 ) -> list[dict]:
    """Upload and process multiple files"""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    if len(files) > settings.max_files_per_upload:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files (max {settings.max_files_per_upload})",
        )

    # Rate limiting
    client_ip = request.client.host if request.client else "unknown"
    if await request.app.state.rate_limiter.is_limited(client_ip):
        raise HTTPException(
            status_code=429, detail="Rate limit exceeded. Please try again later."
        )

    # Save uploads to temp
    temp_files: list[tuple[str, Path]] = []
    for upload_file in files:
        saved = await save_upload_to_temp(upload_file)
        if saved:
            temp_files.append(saved)

    if not temp_files:
        raise HTTPException(
            status_code=400,
            detail="No valid files uploaded. Check file types and sizes.",
        )

    try:
        # Process files in parallel
        executor = request.app.state.executor
        tasks = [
            process_single_file(file_data, name, lastname, executor)
            for file_data in temp_files
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter successful results
        processed = [r for r in results if isinstance(r, ProcessedFile)]

        # Log errors
        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            logger.error("Processing errors: %d files failed", len(errors))

        # Convert to client format and return
        return [processed_file_to_client(p) for p in processed]

    finally:
        # Cleanup temp files in background
        def cleanup_temps() -> None:
            for _, tmp_path in temp_files:
                with suppress(Exception):
                    tmp_path.unlink(missing_ok=True)

        background_tasks.add_task(cleanup_temps)


@app.get("/files")
async def list_files(
    category: Annotated[str | None, Query(description="Filter by category")] = None,
    name: Annotated[str | None, Query(description="Filter by name")] = None,
    lastname: Annotated[str | None, Query(description="Filter by lastname")] = None,
) -> list[dict]:
    """List all stored files with optional filtering"""
    if not settings.upload_folder.exists():
        return []

    results: list[ProcessedFile] = []

    for file_path in sorted(settings.upload_folder.iterdir()):
        if not file_path.is_file():
            continue

        # Parse filename
        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue

        # Apply filters
        if category and metadata["category"] != category:
            continue
        if name and sanitize_name(name) not in metadata["name"]:
            continue
        if lastname and sanitize_name(lastname) not in metadata["name"]:
            continue

        try:
            stat = file_path.stat()
            results.append(
                ProcessedFile(
                    id=metadata["id"],
                    original_name=metadata["original"],
                    category=metadata["category"],
                    filename=file_path.name,
                    size=stat.st_size,
                    modified=int(stat.st_mtime),
                    status="saved",
                )
            )
        except OSError:
            logger.exception("Failed to stat file: %s", file_path)

    # Convert to client format before returning
    return [processed_file_to_client(p) for p in results]


@app.get("/files/{file_id}")
async def download_file(file_id: str) -> FileResponse:
    """Download a file by its ID"""
    if not settings.upload_folder.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Find file with matching parsed ID
    target_file = None
    for file_path in settings.upload_folder.iterdir():
        if not file_path.is_file():
            continue
        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue
        if metadata.get("id") == file_id:
            target_file = file_path
            break

    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Security check: ensure file is within upload folder
    try:
        target_file.resolve().relative_to(settings.upload_folder.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied") from None

    return FileResponse(
        path=target_file,
        filename=target_file.name,
        media_type="application/octet-stream",
    )


@app.get("/download_zip")
async def download_zip(
    name: Annotated[str, Query(min_length=1, max_length=100)],
    lastname: Annotated[str, Query(min_length=1, max_length=100)],
    category: Annotated[str | None, Query(description="Filter by category")] = None,
) -> StreamingResponse:
    """Download multiple files as ZIP archive"""
    if not settings.upload_folder.exists():
        raise HTTPException(status_code=404, detail="No files found")

    # Build search pattern
    sanitized_name = sanitize_name(name)
    sanitized_lastname = sanitize_name(lastname)

    # Collect matching files
    matching_files: list[Path] = []
    for file_path in settings.upload_folder.iterdir():
        if not file_path.is_file():
            continue

        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue

        # Check name and lastname match
        if sanitized_name not in metadata["name"]:
            continue
        if sanitized_lastname not in metadata["name"]:
            continue

        # Check category if specified
        if category and metadata["category"] != category:
            continue

        matching_files.append(file_path)

    if not matching_files:
        raise HTTPException(status_code=404, detail="No matching files found")

    # Create ZIP in memory
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for file_path in matching_files:
            archive.write(file_path, arcname=file_path.name)

    zip_buffer.seek(0)

    filename = f"{sanitized_name}_{sanitized_lastname}_documents.zip"

    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.delete("/files/{file_id}", response_model=FileDeleteResponse)
async def delete_file(file_id: str) -> FileDeleteResponse:
    """Delete a file by its ID"""
    return await _delete_file_by_id(file_id)


async def _delete_file_by_id(file_id: str) -> FileDeleteResponse:
    """Helper to delete stored file by parsed UUID-like id."""
    if not settings.upload_folder.exists():
        raise HTTPException(status_code=404, detail="File not found")

    target_file = None
    for file_path in settings.upload_folder.iterdir():
        if not file_path.is_file():
            continue
        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue
        if metadata.get("id") == file_id:
            target_file = file_path
            break

    if not target_file:
        raise HTTPException(status_code=404, detail="File not found")

    filename = target_file.name

    # Gather metadata to return in response
    stat = None
    try:
        stat = target_file.stat()
    except OSError:
        logger.debug("Could not stat file before deletion: %s", filename)

    # Extract stored metadata where possible
    parsed = parse_stored_filename(filename) or {}

    resp = FileDeleteResponse(
        status="deleted",
        filename=filename,
        id=parsed.get("id") or file_id,
        original_name=parsed.get("original"),
        category=parsed.get("category"),
        size=(stat.st_size if stat is not None else None),
        modified=(int(stat.st_mtime) if stat is not None else None),
    )

    deleted = False
    try:
        target_file.unlink(missing_ok=True)
        deleted = True
        logger.info("Deleted file: %s", filename)
    except OSError:
        logger.exception("Failed to delete file: %s", file_id)
        raise HTTPException(status_code=500, detail="Failed to delete file") from None

    if deleted:
        return resp

    # Should not reach here - raise to indicate failure
    raise HTTPException(status_code=500, detail="Failed to delete file")


# Mount static files for web interface
if settings.web_build_folder.exists():
    app.mount(
        "/", StaticFiles(directory=settings.web_build_folder, html=True), name="static"
    )


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "5040"))
    host = os.getenv("HOST", "0.0.0.0")  # noqa: S104

    uvicorn.run(
        "server:app",
        host=host,
        port=port,
        reload=os.getenv("ENVIRONMENT", "production") != "production",
        log_level=settings.log_level.lower(),
    )
