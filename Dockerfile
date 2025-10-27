# Production multi-stage Dockerfile
# 1) frontend-builder: build the web app with pnpm
# 2) python-builder: create a venv and install runtime python deps
# 3) runtime: copy venv and built frontend, install runtime OS packages and run uvicorn

# --- Frontend builder -----------------------------------------------------
FROM node:24-slim AS frontend-builder
WORKDIR /workspace

# Install pnpm
RUN npm i -g pnpm@latest || true

# Copy only web sources for build
COPY web/package.json web/pnpm-lock.yaml* ./web/
COPY web/ ./web/

# Build the frontend (Vite -> dist)
WORKDIR /workspace/web
RUN CI=true pnpm install --frozen-lockfile && \
    CI=true pnpm run build

# --- Python builder -------------------------------------------------------
FROM python:3.14-slim AS python-builder
WORKDIR /app
ENV PYTHONUNBUFFERED=1

# Install build-time OS deps for some Python packages (poppler/tesseract related)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    python3-dev \
    pkg-config \
    libpoppler-cpp-dev \
    && rm -rf /var/lib/apt/lists/*

# Create venv
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy pyproject and install runtime Python dependencies into venv
COPY api/pyproject.toml ./
RUN pip install --upgrade pip && \
    pip install --no-cache-dir \
    aiofiles>=25.1.0 \
    fastapi[standard-no-fastapi-cloud-cli]>=0.120.0 \
    pdf2image>=1.17.0 \
    pillow>=12.0.0 \
    pydantic>=2.12.3 \
    pydantic-settings>=2.11.0 \
    pytesseract>=0.3.13 \
    rapidfuzz>=3.14.1 \
    uvicorn[standard]>=0.22.0

# Copy application source
COPY api/ /app/

# --- Final runtime image --------------------------------------------------
FROM python:3.14-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1

# Install runtime OS packages required by pdf2image/tesseract conversions
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-rus \
    libtesseract-dev \
    && rm -rf /var/lib/apt/lists/*

# Ensure tesseract can find tessdata
ENV TESSDATA_PREFIX=/usr/share/tessdata

# Create non-root user
RUN useradd --create-home --shell /bin/false appuser || true

# Copy venv from python-builder
COPY --from=python-builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy app source (server) and other files
COPY --from=python-builder /app /app

# Copy built frontend into place to be served by the Python app
COPY --from=frontend-builder /workspace/web/dist /app/build/web

# Ensure uploads directory exists and is writable
RUN mkdir -p /app/uploads && chown -R appuser:appuser /app/uploads /app

USER appuser

EXPOSE 5040

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5040", "--workers", "4"]

