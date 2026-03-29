"""
Modern OCR-based document classification with parallel processing
"""

import asyncio
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import time
import uuid
import zipfile
from collections import defaultdict, deque
from collections.abc import AsyncGenerator
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from pathlib import Path
from types import TracebackType
from typing import Annotated, Self
from urllib.parse import quote as _quote

import aiofiles
import pytesseract
from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.exception_handlers import http_exception_handler
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pdf2image import convert_from_bytes
from PIL import Image, ImageFilter, ImageOps, UnidentifiedImageError
from pydantic import BaseModel
from rapidfuzz import fuzz
from starlette.exceptions import HTTPException as StarletteHTTPException

import auth
from config import settings
from database import (
    close_engine,
    get_session,
    get_sessionmaker,
    init_engine,
    run_migrations,
)
from document_service import (
    DocumentMetadata,
    compute_confidence_score,
    persist_document,
)

# Configure logging BEFORE any other imports that might use logging
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    force=True,
)

# Set specific loggers to DEBUG
logging.getLogger("review").setLevel(logging.DEBUG)
logging.getLogger("review_service").setLevel(logging.DEBUG)
logging.getLogger("uvicorn").setLevel(logging.INFO)
logging.getLogger("uvicorn.access").setLevel(logging.INFO)

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
    confidence: float = 0.0
    db_id: str | None = None  # Database document ID


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
        "newName": p.filename or None,
        "filename": p.filename or None,
        "category": p.category,
        # keep some metadata handy for clients that want it
        "size": p.size,
        "modified": p.modified,
        "status": p.status,
        "confidence": p.confidence,
        "dbId": p.db_id,
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
# TIMING UTILITIES
# ============================================================================


class PerfTimer:
    """Context manager that logs how long an operation takes in milliseconds."""

    def __init__(self, label: str, level: int = logging.INFO) -> None:
        self.label = label
        self.level = level
        self._start = 0.0

    def __enter__(self) -> Self:
        self._start = time.perf_counter()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        duration_ms = (time.perf_counter() - self._start) * 1000
        logger.log(self.level, "Timing[%s]: %.2f ms", self.label, duration_ms)


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


def _tesseract_config() -> str:
    """Return cached tesseract CLI configuration string"""

    return f"--psm {settings.tesseract_psm} --oem 1"


def preprocess_for_ocr(img: Image.Image) -> Image.Image:
    """Lightweight grayscale + contrast tweak to cut OCR time"""

    if img.mode != "L":
        img = ImageOps.grayscale(img)
    # Median filter helps suppress speckle noise before thresholding
    return ImageOps.autocontrast(img.filter(ImageFilter.MedianFilter(size=3)))


def extract_text_from_image(img: Image.Image) -> str:
    """Extract text from a PIL Image using Tesseract"""
    try:
        with PerfTimer(
            f"optimize_image {img.width}x{img.height}",
            level=logging.DEBUG,
        ):
            optimized = optimize_image(img)

        optimized = preprocess_for_ocr(optimized)
        config = _tesseract_config()

        with PerfTimer(
            f"pytesseract_image_to_string {optimized.width}x{optimized.height}"
        ):
            text = pytesseract.image_to_string(
                optimized,
                lang="rus",
                config=config,
                timeout=settings.tesseract_timeout,
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
    result = ""
    try:
        with PerfTimer(f"extract_text total ({ext})"):
            if ext == ".pdf":
                result = _extract_text_from_pdf(file_bytes)
            else:
                result = _extract_text_from_image_bytes(file_bytes)
    except Exception:
        logger.exception("Text extraction failed for extension %s", ext)
        return ""
    else:
        return result


def extract_text_from_path(path: str, ext: str) -> str:
    """Worker-friendly wrapper: read file bytes from disk and extract text.

    This avoids pickling large byte buffers when sending work to a
    ProcessPoolExecutor: we send the filename and let the worker read it.
    """
    result = ""
    label = f"extract_text_from_path total - {Path(path).name}"
    try:
        with PerfTimer(label):
            p = Path(path)
            with (
                PerfTimer(
                    f"read_bytes {p.name}",
                    level=logging.DEBUG,
                ),
                p.open("rb") as f,
            ):
                data = f.read()
            result = extract_text(data, ext)
    except Exception:
        # Use a plain print here because child processes may have different
        # logging config; still call logger for consistency.
        try:
            logger.exception("Failed to extract text from path %s", path)
        except Exception:
            print(f"Failed to extract text from path {path}")
        return ""
    else:
        return result


def _extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract text from PDF bytes with parallel page processing"""
    try:
        with PerfTimer(
            f"convert_from_bytes {len(file_bytes)} bytes",
            level=logging.INFO,
        ):
            images = convert_from_bytes(
                file_bytes,
                first_page=1,
                last_page=settings.max_pages_ocr,
                dpi=settings.pdf_dpi,
            )

        if not images:
            return ""

        # Process pages in parallel using ThreadPoolExecutor
        # Tesseract releases GIL, so threads work well here
        max_workers = min(settings.pdf_parallel_pages, len(images), os.cpu_count() or 1)

        with (
            PerfTimer(f"pdf ocr threadpool {len(images)} pages"),
            ThreadPoolExecutor(max_workers=max_workers) as executor,
        ):
            # Submit all pages for OCR
            future_to_idx = {
                executor.submit(extract_text_from_image, img): idx
                for idx, img in enumerate(images)
            }

            # Collect results in order
            texts = [""] * len(images)
            total_length = 0

            # Process completed futures as they finish
            for future in as_completed(future_to_idx):
                idx = future_to_idx[future]
                try:
                    text = future.result()
                    texts[idx] = text
                    total_length += len(text)

                    # Could potentially stop early, but we want all submitted
                    # jobs to complete to avoid resource issues
                except Exception:
                    logger.exception("Failed to extract text from page %d", idx + 1)
                    texts[idx] = ""

        # Filter out empty texts and join
        combined = "\n".join(t for t in texts if t)
        return combined[: settings.max_text_extract_length]

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


@lru_cache(maxsize=256)
def classify_text(text: str) -> tuple[DocumentCategory, float | None]:
    """Classify text using a fast exact containment check first, then
    a fuzzy-match fallback. Caching is enabled to avoid repeated work for
    identical OCR results.

    Returns tuple of (DocumentCategory, fuzzy_score).
    fuzzy_score is None for exact matches, or 0-100 for fuzzy matches.
    Returns (DocumentCategory.UNCLASSIFIED, 0) when no keyword matches.
    """
    with PerfTimer(f"classify_text len={len(text)}", level=logging.DEBUG):
        if not text:
            return (DocumentCategory.UNCLASSIFIED, 0.0)

        lower_text = text.strip().lower()

        # Fast exact containment check
        for category, keywords in CATEGORY_KEYWORDS.items():
            for kw in keywords:
                if kw and kw.lower() in lower_text:
                    return (category, None)  # Exact match, high confidence

        # Fuzzy fallback — compute best score and category
        best_category = DocumentCategory.UNCLASSIFIED
        best_score = 0
        for category, keywords in CATEGORY_KEYWORDS.items():
            for kw in keywords:
                if not kw:
                    continue
                try:
                    score = fuzz.token_set_ratio(kw.lower(), lower_text)
                except Exception:
                    score = 0
                if score > best_score:
                    best_score = score
                    best_category = category

        if best_score >= 60:
            return (best_category, float(best_score))
        return (DocumentCategory.UNCLASSIFIED, 0.0)


# ============================================================================
# CACHE MANAGEMENT
# ============================================================================


def compute_file_hash(file_bytes: bytes) -> str:
    """Compute SHA256 hash of file bytes for cache key"""
    return hashlib.sha256(file_bytes).hexdigest()


def get_cache_path(file_hash: str) -> Path:
    """Get cache file path for a given file hash"""
    # Use subdirectories to avoid too many files in one directory
    subdir = file_hash[:2]
    return settings.cache_folder / subdir / f"{file_hash}.json"


async def get_cached_result(file_hash: str) -> dict | None:
    """Retrieve cached OCR result if available and not expired"""
    cache_path = get_cache_path(file_hash)

    if not cache_path.exists():
        return None

    try:
        # Check if cache is expired
        mtime = cache_path.stat().st_mtime
        age_days = (time.time() - mtime) / 86400
        if age_days > settings.cache_ttl_days:
            logger.debug("Cache expired for hash %s", file_hash[:8])
            cache_path.unlink(missing_ok=True)
            return None

        async with aiofiles.open(cache_path, encoding="utf-8") as f:
            content = await f.read()
            result = json.loads(content)
            logger.info("Cache hit for hash %s", file_hash[:8])
            return result
    except Exception:
        logger.exception("Failed to read cache for hash %s", file_hash[:8])
        return None


async def save_cached_result(
    file_hash: str, text: str, category: str, fuzzy_score: float | None = None
) -> None:
    """Save OCR result to cache"""
    cache_path = get_cache_path(file_hash)

    try:
        cache_path.parent.mkdir(parents=True, exist_ok=True)

        cache_data = {
            "text": text,
            "category": category,
            "fuzzy_score": fuzzy_score,
            "timestamp": time.time(),
        }

        async with aiofiles.open(cache_path, "w", encoding="utf-8") as f:
            await f.write(json.dumps(cache_data, ensure_ascii=False))

        logger.debug("Cached result for hash %s", file_hash[:8])
    except Exception:
        logger.exception("Failed to save cache for hash %s", file_hash[:8])


async def cleanup_cache() -> int:
    """Remove expired cache entries"""
    if not settings.cache_folder.exists():
        return 0

    cutoff = time.time() - settings.cache_ttl_days * 24 * 3600
    removed = 0

    try:
        for subdir in settings.cache_folder.iterdir():
            if not subdir.is_dir():
                continue

            for cache_file in subdir.iterdir():
                if not cache_file.is_file() or cache_file.suffix != ".json":
                    continue

                try:
                    mtime = cache_file.stat().st_mtime
                    if mtime < cutoff:
                        cache_file.unlink()
                        removed += 1
                except OSError:
                    logger.exception(
                        "Failed to check/remove cache file: %s", cache_file
                    )

            # Remove empty subdirectories
            with suppress(OSError):
                if not any(subdir.iterdir()):
                    subdir.rmdir()
    except Exception:
        logger.exception("Cache cleanup error")

    if removed:
        logger.info("Cache cleanup removed %d expired entries", removed)

    return removed


def _find_uuid_and_pos(stem: str) -> tuple[str | None, int | None]:
    """Return (uuid, position_in_tokens) or (None, None)"""
    uuid_re = re.compile(
        r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    )
    m = uuid_re.search(stem)
    if not m:
        return None, None

    file_id = m.group(1)
    tokens = stem.split("_")
    try:
        pos = tokens.index(file_id)
    except ValueError:
        pos = None
        for i, t in enumerate(tokens):
            if file_id in t:
                pos = i
                break

    return file_id, pos


def _canonical_category(token: str) -> str | None:
    """Return canonical DocumentCategory.value for token or None"""
    for cat in DocumentCategory:
        if cat.value.lower() == token.lower():
            return cat.value
    return None


def parse_stored_filename(filename: str) -> dict[str, str] | None:
    """Parse metadata from stored filename format:

    Expected stored filename format (strict):
    {name}_{lastname}_{CategoryValue}_{idx}_{uuid}{ext}

    This function extracts the UUID, category, name and a reconstructed
    original-like value (name_lastname) from the filename. It is intentionally
    permissive about name/lastname contents but reliably parses the trailing
    {category}_{idx}_{uuid} suffix.
    """

    stem = Path(filename).stem

    file_id, uuid_pos = _find_uuid_and_pos(stem)
    if not file_id or uuid_pos is None:
        return None

    tokens = stem.split("_")
    # Expect at minimum: name, lastname, category, idx, uuid
    if len(tokens) < 5:
        return None

    # tokens before uuid: leading... category, idx
    if uuid_pos < 3:
        return None

    category_token = tokens[uuid_pos - 2]
    idx_token = tokens[uuid_pos - 1]

    leading = tokens[: uuid_pos - 2]
    if len(leading) < 2:
        return None

    name_token = leading[0]
    lastname_token = "_".join(leading[1:])

    canonical = _canonical_category(category_token)
    if not canonical:
        return None

    original_like = f"{name_token}_{lastname_token}"

    return {
        "id": file_id,
        "category": canonical,
        "name": f"{name_token}_{lastname_token}",
        "original": original_like,
        "index": idx_token,
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
        with suppress(Exception):
            await upload_file.close()
        return None

    if not validate_file_extension(upload_file.filename):
        logger.warning("Rejected extension: %s", upload_file.filename)
        with suppress(Exception):
            await upload_file.close()
        return None

    if not validate_mimetype(upload_file.content_type):
        logger.warning(
            "Rejected content-type %s for %s",
            upload_file.content_type,
            upload_file.filename,
        )
        with suppress(Exception):
            await upload_file.close()
        return None

    fd, tmp_path_str = tempfile.mkstemp(
        prefix="upload_", suffix=Path(upload_file.filename).suffix
    )
    os.close(fd)

    tmp_path = Path(tmp_path_str)
    total_size = 0
    try:
        with PerfTimer(f"save_upload_to_temp {upload_file.filename}"):
            async with aiofiles.open(tmp_path, "wb") as afp:
                while chunk := await upload_file.read(settings.upload_chunk_size):
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
        with suppress(Exception):
            await upload_file.close()
        return (upload_file.filename, tmp_path)


async def process_single_file(  # noqa: PLR0915
    file_data: tuple[str, Path],
    name: str,
    lastname: str,
    executor: ProcessPoolExecutor,
) -> ProcessedFile | None:
    """Process a single uploaded file: OCR, classify, and store with caching"""
    original_name, tmp_path = file_data
    ext = Path(original_name).suffix.lower()
    process_label = f"process_single_file {original_name}"

    try:
        with PerfTimer(process_label):
            # Read file bytes for hashing and potential storage
            async with aiofiles.open(tmp_path, "rb") as afp:
                with PerfTimer(
                    f"read_tmp_file {original_name}",
                    level=logging.DEBUG,
                ):
                    file_bytes = await afp.read()

            file_id = str(uuid.uuid4())
            size = len(file_bytes)
            modified = int(time.time())

            # Compute hash for cache lookup
            with PerfTimer(
                f"compute_hash {original_name}",
                level=logging.DEBUG,
            ):
                file_hash = compute_file_hash(file_bytes)

            with PerfTimer(
                f"cache_lookup {file_hash[:8]}",
                level=logging.DEBUG,
            ):
                cached_result = await get_cached_result(file_hash)

            fuzzy_score = None
            if cached_result:
                # Cache hit - use cached text and category
                text = cached_result.get("text", "")
                category_value = cached_result.get(
                    "category", DocumentCategory.UNCLASSIFIED.value
                )
                fuzzy_score = cached_result.get("fuzzy_score")
                try:
                    category = DocumentCategory(category_value)
                except ValueError:
                    category = DocumentCategory.UNCLASSIFIED
                logger.info(
                    "Using cached result for %s (hash: %s)",
                    original_name,
                    file_hash[:8],
                )
            else:
                # Cache miss - perform OCR using path-based worker (no pickle overhead)
                loop = asyncio.get_event_loop()
                with PerfTimer(
                    f"ocr_executor {original_name}",
                ):
                    text = await loop.run_in_executor(
                        executor, extract_text_from_path, str(tmp_path), ext
                    )
                category, fuzzy_score = classify_text(text)

                # Save to cache for future use
                with PerfTimer(
                    f"cache_save {file_hash[:8]}",
                    level=logging.DEBUG,
                ):
                    await save_cached_result(
                        file_hash, text, category.value, fuzzy_score
                    )

            # Clean up temp file now that we have the bytes and OCR is done
            with (
                suppress(Exception),
                PerfTimer(
                    f"cleanup_tmp {original_name}",
                    level=logging.DEBUG,
                ),
            ):
                tmp_path.unlink(missing_ok=True)

            # Compute confidence score
            confidence = compute_confidence_score(category.value, text, fuzzy_score)

            filename = ""
            status = "unclassified"
            db_id = None

            if category != DocumentCategory.UNCLASSIFIED:
                # Filename format: {name}_{lastname}_{category.value}_{idx}_{file_id}{ext}
                sanitized_name = sanitize_name(name)
                sanitized_lastname = sanitize_name(lastname)

                idx = 1
                while idx <= 100:  # Reasonable limit
                    candidate = (
                        f"{sanitized_name}_{sanitized_lastname}_"
                        f"{category.value}_{idx}_{file_id}{ext}"
                    )
                    dest = settings.upload_folder / candidate
                    if not dest.exists():
                        filename = candidate
                        with PerfTimer(
                            f"write_atomic {candidate}",
                            level=logging.DEBUG,
                        ):
                            await write_atomic(dest, file_bytes)
                        status = "saved"
                        logger.info(
                            "Saved file: %s as %s", original_name, category.value
                        )
                        break
                    idx += 1
                else:
                    logger.error(
                        "Too many file collisions for %s_%s",
                        sanitized_name,
                        sanitized_lastname,
                    )
                    return None

                # Persist to database
                mime_type = (
                    f"application/{ext[1:]}" if ext == ".pdf" else f"image/{ext[1:]}"
                )
                try:
                    sessionmaker = get_sessionmaker()
                    async with sessionmaker() as session:
                        metadata = DocumentMetadata(
                            original_name=original_name,
                            file_path=str(
                                dest.relative_to(settings.upload_folder.parent)
                            ),
                            file_size=size,
                            mime_type=mime_type,
                            category=category.value,
                            confidence_score=confidence,
                            applicant_name=name,
                            applicant_lastname=lastname,
                            text_excerpt=text[:500] if text else None,
                        )
                        doc = await persist_document(session, metadata)
                        await session.commit()
                        db_id = doc.id
                        logger.info("Persisted document to database: %s", db_id)
                except Exception:
                    logger.exception(
                        "Failed to persist document %s to database", original_name
                    )
                    # Don't fail the upload, just log the error

            return ProcessedFile(
                id=file_id,
                original_name=original_name,
                category=category.value,
                filename=filename,
                size=size,
                modified=modified,
                status=status,
                confidence=confidence,
                db_id=db_id,
            )

    except Exception as exc:
        logger.exception("Failed to process file: %s", original_name)
        # Clean up temp file on error
        with suppress(Exception):
            tmp_path.unlink(missing_ok=True)
        # Return error info instead of None for better error reporting
        return ProcessedFile(
            id=str(uuid.uuid4()),
            original_name=original_name,
            category="ERROR",
            filename="",
            size=0,
            modified=int(time.time()),
            status=f"error: {str(exc)[:100]}",
            confidence=0.0,
            db_id=None,
        )


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
    settings.cache_folder.mkdir(parents=True, exist_ok=True)
    await run_migrations()
    init_engine()
    app.state.db_session_factory = get_sessionmaker()

    app.state.rate_limiter = RateLimiter(settings.rate_limit_per_minute)
    # For CPU-bound OCR work prefer processes. Cap to number of CPUs.
    cpu_count = os.cpu_count() or 1
    max_workers = max(1, min(settings.max_workers, cpu_count))
    app.state.executor = ProcessPoolExecutor(
        max_workers=max_workers,
        max_tasks_per_child=settings.max_tasks_per_child,
    )

    # Background cleanup task
    async def cleanup_loop() -> None:
        while True:
            try:
                await asyncio.sleep(settings.cleanup_interval_seconds)
                await cleanup_old_files()
                await cleanup_cache()
                await app.state.rate_limiter.cleanup_old_entries()
            except asyncio.CancelledError:
                break
            except Exception:
                logger.exception("Cleanup loop error")

    app.state.cleanup_task = asyncio.create_task(cleanup_loop())

    yield

    # Shutdown
    app.state.cleanup_task.cancel()
    with suppress(asyncio.CancelledError):
        await app.state.cleanup_task

    app.state.executor.shutdown(wait=True)
    await close_engine()
    logger.info("Application shutdown complete")


app = FastAPI(
    title="AI Reception - Document Classification",
    description="OCR-based document classification system",
    version="2.1.0",
    lifespan=lifespan,
)

# Add CORS middleware FIRST (middleware is applied in reverse order)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:5040",  # Backend port (for serving frontend)
        "https://ai-reception.tou.edu.kz",  # Production domain
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# Add exception handlers to ensure CORS headers on error responses
@app.exception_handler(StarletteHTTPException)
async def http_exception_cors_handler(
    request: Request, exc: StarletteHTTPException
) -> JSONResponse:
    """Preserve HTTP error status codes while attaching CORS headers."""
    response = await http_exception_handler(request, exc)
    origin = request.headers.get("Origin")
    response.headers["Access-Control-Allow-Origin"] = origin or "*"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle unexpected errors and ensure CORS headers."""
    logger.exception(
        "Unhandled exception in %s %s: %s",
        request.method,
        request.url.path,
        exc,
    )

    origin = request.headers.get("Origin")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers={
            "Access-Control-Allow-Origin": origin or "*",
            "Access-Control-Allow-Credentials": "true",
        },
    )


# Include routers AFTER middleware
app.include_router(auth.router)

# Import review router after app is created to avoid circular imports
import review  # noqa: E402

app.include_router(review.router)


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
    name: Annotated[str, Form(min_length=1, max_length=100)],
    lastname: Annotated[str, Form(min_length=1, max_length=100)],
    files: Annotated[list[UploadFile], File()],
) -> dict:
    """Upload and process multiple files with detailed error reporting"""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")

    if len(files) > settings.max_files_per_upload:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files (max {settings.max_files_per_upload})",
        )

    client_ip = request.client.host if request.client else "unknown"
    if await request.app.state.rate_limiter.is_limited(client_ip):
        raise HTTPException(
            status_code=429, detail="Rate limit exceeded. Please try again later."
        )

    temp_files: list[tuple[str, Path]] = []
    rejected_files: list[dict] = []

    for upload_file in files:
        saved = await save_upload_to_temp(upload_file)
        if saved:
            temp_files.append(saved)
        else:
            rejected_files.append(
                {
                    "filename": upload_file.filename or "unknown",
                    "error": "Invalid file type or size",
                }
            )

    if not temp_files:
        raise HTTPException(
            status_code=400,
            detail="No valid files uploaded. Check file types and sizes.",
        )

    # Process files
    executor = request.app.state.executor
    tasks = [
        process_single_file(file_data, name, lastname, executor)
        for file_data in temp_files
    ]
    results = await asyncio.gather(*tasks, return_exceptions=False)

    # Separate success, unclassified and failures
    successful: list[dict] = []
    unclassified: list[dict] = []
    failed: list[dict] = []

    for result in results:
        # skip None results (shouldn't happen but be defensive)
        if not result:
            continue

        # explicit error status (process_single_file uses "error:..." on failures)
        if isinstance(result.status, str) and result.status.startswith("error"):
            failed.append({"filename": result.original_name, "error": result.status})
        elif result.status == "unclassified":
            # include unclassified files so clients can review or re-upload
            unclassified.append(processed_file_to_client(result))
        else:
            successful.append(processed_file_to_client(result))

    return {
        "success": successful,
        "unclassified": unclassified,
        "failed": failed + rejected_files,
        "summary": {
            "total": len(files),
            "successful": len(successful),
            "unclassified": len(unclassified),
            "failed": len(failed) + len(rejected_files),
        },
    }


def _list_files_sync(
    category: str | None, name: str | None, lastname: str | None
) -> list[dict]:
    """Synchronous file listing to run in executor"""
    if not settings.upload_folder.exists():
        return []

    results: list[ProcessedFile] = []

    for file_path in sorted(settings.upload_folder.iterdir()):
        if not file_path.is_file():
            continue

        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue

        # Apply filters - for privacy, require both name and lastname to be
        # provided and match the stored metadata. If name/lastname are not
        # provided, do not return any files to avoid exposing listings.
        if not name or not lastname:
            continue

        sanitized_name = sanitize_name(name)
        sanitized_lastname = sanitize_name(lastname)

        # The stored `metadata["name"]` is expected to contain the
        # sanitized name and lastname (name_lastname). Require both to match.
        if (
            sanitized_name not in metadata["name"]
            or sanitized_lastname not in metadata["name"]
        ):
            continue

        if category and metadata["category"] != category:
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

    return [processed_file_to_client(p) for p in results]


@app.get("/files")
async def list_files(
    category: Annotated[str | None, Query(description="Filter by category")] = None,
    name: Annotated[str | None, Query(description="Filter by name")] = None,
    lastname: Annotated[str | None, Query(description="Filter by lastname")] = None,
) -> list[dict]:
    """List all stored files with optional filtering - non-blocking"""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _list_files_sync, category, name, lastname)


@app.get("/files/{file_id}")
async def download_file(
    file_id: str,
    name: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    lastname: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> FileResponse:
    """Download a file by its ID. Require name and lastname to match stored file metadata."""
    if not settings.upload_folder.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Find file with matching parsed ID
    target_file = None
    target_metadata = None
    for file_path in settings.upload_folder.iterdir():
        if not file_path.is_file():
            continue
        metadata = parse_stored_filename(file_path.name)
        if not metadata:
            continue
        if metadata.get("id") == file_id:
            target_file = file_path
            target_metadata = metadata
            break

    if not target_file or not target_file.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Require name and lastname for privacy
    if not name or not lastname:
        raise HTTPException(status_code=403, detail="Access denied")

    sanitized_name = sanitize_name(name)
    sanitized_lastname = sanitize_name(lastname)

    metadata_name = (target_metadata or {}).get("name", "").lower()
    expected = f"{sanitized_name}_{sanitized_lastname}".lower()
    if metadata_name != expected:
        # Don't reveal whether the file exists; just deny access
        raise HTTPException(status_code=403, detail="Access denied")

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

        # Match full sanitized name exactly (case-insensitive) to avoid
        # accidental substring mismatches (and differences in case).
        metadata_name = metadata.get("name", "")
        if metadata_name.lower() != f"{sanitized_name}_{sanitized_lastname}".lower():
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

    # Build RFC-5987 compliant Content-Disposition header so non-latin1
    # characters don't cause encoding errors when Starlette attempts to
    # encode headers as latin-1. Provide an ASCII fallback and a UTF-8
    # percent-encoded `filename*` parameter.

    ascii_filename = filename.encode("ascii", errors="replace").decode("ascii")
    quoted = _quote(filename, safe="")
    content_disp = (
        f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{quoted}"
    )

    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": content_disp},
    )


@app.delete("/files/{file_id}", response_model=FileDeleteResponse)
async def delete_file(
    file_id: str,
    name: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
    lastname: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
) -> FileDeleteResponse:
    """Delete a file by its ID. Require name and lastname to match stored file metadata."""
    return await _delete_file_by_id(file_id, name, lastname)


async def _delete_file_by_id(
    file_id: str, name: str | None, lastname: str | None
) -> FileDeleteResponse:
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

    # Require name and lastname for privacy; validate match
    if not name or not lastname:
        raise HTTPException(status_code=403, detail="Access denied")

    parsed_meta = parse_stored_filename(target_file.name) or {}
    metadata_name = parsed_meta.get("name", "").lower()
    expected = f"{sanitize_name(name)}_{sanitize_name(lastname)}".lower()
    if metadata_name != expected:
        raise HTTPException(status_code=403, detail="Access denied")

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

    env = os.getenv("ENVIRONMENT", "production")
    is_prod = str(env).lower() == "production"
    reload_enabled = not is_prod

    # Configure uvicorn logging to use our log level and show our app logs
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["formatters"]["default"]["fmt"] = (
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    log_config["formatters"]["access"]["fmt"] = (
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    log_config["loggers"]["review"] = {"handlers": ["default"], "level": "DEBUG"}
    log_config["loggers"]["review_service"] = {
        "handlers": ["default"],
        "level": "DEBUG",
    }

    uvicorn.run(
        app,
        host=host,
        port=port,
        reload=reload_enabled,
        log_level="debug",  # Force debug level
        log_config=log_config,
    )
