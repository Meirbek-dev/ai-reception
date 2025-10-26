"""
Modern OCR-based document classification
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
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import aiofiles
import numpy as np
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
from paddleocr import PaddleOCR
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
    max_request_size: int = Field(default=500 * 1024 * 1024, gt=0)
    max_workers: int = Field(default=min(4, os.cpu_count() or 1), gt=0)
    ocr_workers: int = Field(default=min(2, os.cpu_count() or 1), gt=0)  # NEW
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
    ocr_timeout_seconds: int = Field(default=120, gt=1)

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
# OCR WORKER FUNCTIONS (for ProcessPoolExecutor)
# ============================================================================

# Global OCR instance per worker process
_ocr_instance = None


def _init_ocr_worker() -> None:
    """Initialize OCR in worker process"""
    global _ocr_instance
    try:
        # Try the constructor compatible with older paddleocr versions first.
        # Some paddleocr releases accept `use_gpu`, others don't. Attempt both.
        try:
            _ocr_instance = PaddleOCR(use_angle_cls=True, lang="ru", use_gpu=False)
            logger.info("OCR initialized in worker process (use_gpu=False)")
        except (TypeError, ValueError) as exc:
            # Newer paddleocr versions may not accept `use_gpu`; fall back.
            msg = str(exc)
            if "use_gpu" in msg or "Unknown argument" in msg:
                logger.debug(
                    "PaddleOCR constructor rejected use_gpu, retrying without it: %s",
                    msg,
                )
                _ocr_instance = PaddleOCR(use_angle_cls=True, lang="ru")
                logger.info("OCR initialized in worker process (no use_gpu)")
            else:
                raise
    except Exception:
        logger.exception("Failed to initialize OCR in worker")
        raise


def _ocr_worker_extract(image_array: np.ndarray) -> list:
    """OCR extraction in worker process"""
    global _ocr_instance
    if _ocr_instance is None:
        _init_ocr_worker()
    return _ocr_instance.ocr(image_array)


def _extract_text_from_pdf_worker(
    file_bytes: bytes, max_pages: int, max_length: int
) -> str:
    """Extract text from PDF in worker process"""
    try:
        images = convert_from_bytes(
            file_bytes,
            first_page=1,
            last_page=max_pages,
            dpi=200,
        )

        texts = []
        total_length = 0

        for image in images:
            # Optimize image
            if image.mode not in ("RGB", "L"):
                image = image.convert("L")  # Grayscale for faster OCR

            max_size = 2000
            if max(image.size) > max_size:
                image.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

            # Convert to numpy array
            arr = np.array(image, dtype=np.uint8)

            if arr.ndim == 2:
                arr = np.stack((arr, arr, arr), axis=-1)
            elif arr.ndim == 3 and arr.shape[2] == 4:
                arr = arr[:, :, :3]

            if not arr.flags["C_CONTIGUOUS"]:
                arr = np.ascontiguousarray(arr)

            # Run OCR
            result = _ocr_worker_extract(arr)

            # Extract text
            for line in result:
                for rec in line:
                    try:
                        candidate = (
                            rec[1][0]
                            if isinstance(rec[1], (list, tuple))
                            else str(rec[1])
                        )
                    except Exception:
                        candidate = ""
                    if candidate:
                        texts.append(candidate)
                        total_length += len(candidate)
                    if total_length >= max_length:
                        break
                if total_length >= max_length:
                    break

        return "\n".join(texts)[:max_length]
    except Exception:
        logger.exception("PDF text extraction failed in worker")
        return ""


def _extract_text_from_image_worker(file_bytes: bytes, max_length: int) -> str:
    """Extract text from image in worker process"""
    try:
        img = Image.open(io.BytesIO(file_bytes))

        # Optimize image
        if img.mode not in ("RGB", "L"):
            img = img.convert("L")  # Grayscale

        max_size = 2000
        if max(img.size) > max_size:
            img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)

        # Convert to numpy
        arr = np.array(img, dtype=np.uint8)

        if arr.ndim == 2:
            arr = np.stack((arr, arr, arr), axis=-1)
        elif arr.ndim == 3 and arr.shape[2] == 4:
            arr = arr[:, :, :3]

        if not arr.flags["C_CONTIGUOUS"]:
            arr = np.ascontiguousarray(arr)

        # Run OCR
        result = _ocr_worker_extract(arr)

        # Extract text
        texts = []
        total_len = 0
        for line in result:
            for rec in line:
                try:
                    candidate = (
                        rec[1][0] if isinstance(rec[1], (list, tuple)) else str(rec[1])
                    )
                except Exception:
                    candidate = ""
                if candidate:
                    texts.append(candidate)
                    total_len += len(candidate)
                if total_len >= max_length:
                    break
            if total_len >= max_length:
                break

        return "\n".join(texts)[:max_length]
    except Exception:
        logger.exception("Image text extraction failed in worker")
        return ""


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

# Pre-process keywords for faster matching
_PREPROCESSED_KEYWORDS = {
    cat: tuple(kw.lower() for kw in kws) for cat, kws in CATEGORY_KEYWORDS.items()
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
    ocr_workers: int
    upload_folder_exists: bool


class ErrorResponse(BaseModel):
    """Standard error response"""

    detail: str
    error_code: str | None = None


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

    safe = "".join(c if (c.isalnum() or c in ("_", "-")) else "_" for c in name)

    while "__" in safe:
        safe = safe.replace("__", "_")

    safe = safe.strip("_")[:max_length]

    return safe or "anon"


@lru_cache(maxsize=512)
def classify_text(text: str) -> DocumentCategory:
    """Classify text using optimized fuzzy matching with caching"""
    if not text:
        return DocumentCategory.UNCLASSIFIED

    # Limit text length for matching
    text_lower = text[:2000].lower()

    best_category = DocumentCategory.UNCLASSIFIED
    best_score = 0.0

    for category, keywords in _PREPROCESSED_KEYWORDS.items():
        for kw in keywords:
            try:
                score = fuzz.token_set_ratio(kw, text_lower)
            except Exception:
                score = 0.0
            if score > best_score:
                best_score = score
                best_category = category

    if best_score < 50:
        return DocumentCategory.UNCLASSIFIED

    return best_category


def parse_stored_filename(filename: str) -> dict[str, str] | None:
    """Parse metadata from stored filename format"""
    parts = filename.split("__")
    if len(parts) < 3:
        return None

    category = parts[0]
    name = parts[1]
    remainder = "__".join(parts[2:])
    stem = Path(remainder).stem

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
        raise
    except OSError as exc:
        tmp_path.unlink(missing_ok=True)
        logger.exception("Failed to save upload: %s", upload_file.filename)
        raise HTTPException(
            status_code=400,
            detail=f"Failed to save uploaded file: {upload_file.filename}",
        ) from exc
    else:
        return (upload_file.filename, tmp_path)


async def process_single_file(
    file_data: tuple[str, Path],
    name: str,
    lastname: str,
    ocr_executor: ProcessPoolExecutor,
) -> ProcessedFile | None:
    """Process a single uploaded file: OCR, classify, and store"""
    original_name, tmp_path = file_data
    ext = Path(original_name).suffix.lower()

    try:
        # Read file
        async with aiofiles.open(tmp_path, "rb") as afp:
            file_bytes = await afp.read()

        # Pre-process images in-process to reduce IPC size when possible
        if ext != ".pdf":
            try:
                img = Image.open(io.BytesIO(file_bytes))
                if img.mode not in ("RGB", "L"):
                    img = img.convert("RGB")
                max_size = settings.image_max_size
                if max(img.size) > max_size:
                    img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=75)
                file_bytes = buf.getvalue()
            except Exception:
                # If pre-processing fails, continue with original bytes
                logger.debug("Image pre-processing failed, using original bytes")

        # Extract text in process pool (true parallelism) with timeout
        loop = asyncio.get_running_loop()
        try:
            if ext == ".pdf":
                fut = loop.run_in_executor(
                    ocr_executor,
                    _extract_text_from_pdf_worker,
                    file_bytes,
                    settings.max_pages_ocr,
                    settings.max_text_extract_length,
                )
            else:
                fut = loop.run_in_executor(
                    ocr_executor,
                    _extract_text_from_image_worker,
                    file_bytes,
                    settings.max_text_extract_length,
                )

            text = await asyncio.wait_for(fut, timeout=settings.ocr_timeout_seconds)
        except TimeoutError:
            logger.warning("OCR timed out for file: %s", original_name)
            text = ""

        # Classify
        category = classify_text(text)

        # Generate unique ID
        file_id = str(uuid.uuid4())
        size = len(file_bytes)
        modified = int(time.time())

        filename = ""
        status = "unclassified"

        if category != DocumentCategory.UNCLASSIFIED:
            base_name = (
                f"{category.value}__"
                f"{sanitize_name(name)}_{sanitize_name(lastname)}__"
                f"{sanitize_name(Path(original_name).stem)}"
            )

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
                if idx > 1000:
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
# STREAMING ZIP GENERATOR
# ============================================================================


async def generate_zip_stream(files: list[Path]) -> AsyncGenerator[bytes]:
    """Generate ZIP file in chunks to reduce memory usage"""
    # Create temp file for ZIP
    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)

    try:
        # Write ZIP to temp file
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in files:
                archive.write(file_path, arcname=file_path.name)

        # Stream file in chunks
        async with aiofiles.open(tmp_path, "rb") as f:
            while chunk := await f.read(65536):  # 64KB chunks
                yield chunk
    finally:
        with suppress(Exception):
            Path(tmp_path).unlink()


# ============================================================================
# FASTAPI APPLICATION
# ============================================================================


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    """Application lifespan: startup and shutdown"""
    # Startup
    settings.upload_folder.mkdir(parents=True, exist_ok=True)

    app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)

    # Separate executors: threads for I/O, processes for CPU
    app.state.io_executor = ThreadPoolExecutor(max_workers=settings.max_workers)
    app.state.ocr_executor = ProcessPoolExecutor(
        max_workers=settings.ocr_workers,
        initializer=_init_ocr_worker,
    )

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
    logger.info("Application started with %d OCR workers", settings.ocr_workers)

    yield

    # Shutdown
    app.state.cleanup_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.cleanup_task

    app.state.io_executor.shutdown(wait=True)
    app.state.ocr_executor.shutdown(wait=True)
    logger.info("Application shutdown complete")


app = FastAPI(
    title="AI Reception - Document Classification",
    description="OCR-based document classification system",
    version="0.1.0",
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
        version="0.1.0",
        workers=settings.max_workers,
        ocr_workers=settings.ocr_workers,
        upload_folder_exists=settings.upload_folder.exists(),
    )


@app.post("/upload", response_model=list[ProcessedFile])
async def upload_files(
    request: Request,
    background_tasks: BackgroundTasks,
    name: Annotated[str, Form(min_length=1, max_length=100)],
    lastname: Annotated[str, Form(min_length=1, max_length=100)],
    files: Annotated[list[UploadFile], File()],
) -> list[ProcessedFile]:
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

    # Enforce max request size early if client provided Content-Length
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > settings.max_request_size:
                raise HTTPException(
                    status_code=413,
                    detail=(
                        f"Total request size exceeds {settings.max_request_size} bytes"
                    ),
                )
        except ValueError:
            # Ignore malformed header
            pass

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
        # Process files in parallel using OCR process pool
        ocr_executor = request.app.state.ocr_executor
        tasks = [
            process_single_file(file_data, name, lastname, ocr_executor)
            for file_data in temp_files
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Filter successful results
        processed = [r for r in results if isinstance(r, ProcessedFile)]

        # Log errors
        errors = [r for r in results if isinstance(r, Exception)]
        if errors:
            logger.error("Processing errors: %d files failed", len(errors))

        return processed

    finally:
        # Cleanup temp files in background
        def cleanup_temps() -> None:
            for _, tmp_path in temp_files:
                with suppress(Exception):
                    tmp_path.unlink(missing_ok=True)

        background_tasks.add_task(cleanup_temps)


@app.get("/files", response_model=list[ProcessedFile])
async def list_files(
    category: Annotated[str | None, Query(description="Filter by category")] = None,
    name: Annotated[str | None, Query(description="Filter by name")] = None,
    lastname: Annotated[str | None, Query(description="Filter by lastname")] = None,
) -> list[ProcessedFile]:
    """List all stored files with optional filtering"""
    if not settings.upload_folder.exists():
        return []

    results: list[ProcessedFile] = []

    for file_path in sorted(settings.upload_folder.iterdir()):
        if not file_path.is_file():
            continue

        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue

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

    return results


@app.get("/files/{file_id}")
async def download_file(file_id: str) -> FileResponse:
    """Download a file by its ID"""
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

    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail="File not found")

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
    """Download multiple files as ZIP archive with streaming"""
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

        if sanitized_name not in metadata["name"]:
            continue
        if sanitized_lastname not in metadata["name"]:
            continue

        if category and metadata["category"] != category:
            continue

        matching_files.append(file_path)

    if not matching_files:
        raise HTTPException(status_code=404, detail="No matching files found")

    filename = f"{sanitized_name}_{sanitized_lastname}_documents.zip"

    # Stream ZIP instead of building in memory
    return StreamingResponse(
        generate_zip_stream(matching_files),
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
