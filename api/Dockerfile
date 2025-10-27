## Multi-stage Dockerfile optimized for size and security
### Frontend builder: use Node image to build static assets inside the image
FROM node:24-slim AS frontend-builder
WORKDIR /workspace

# Install pnpm and deps; copy package files
COPY package.json pnpm-lock.yaml* ./
RUN npm i -g pnpm@latest || true
RUN pnpm fetch || true
COPY . .

# Build frontend to /workspace/api/build/web
RUN pnpm install --frozen-lockfile --no-private && \
    pnpm run build:frontend


### Python builder: create virtualenv and install runtime Python packages
FROM python:3.13.9-slim AS builder

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Install build-time dependencies (minimal)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3-dev libpoppler-cpp-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Create a virtualenv and install runtime Python packages into it
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy pyproject and install pinned dependencies into the venv
COPY pyproject.toml ./
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

## Final stage: smaller runtime image
FROM python:3.13.9-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# Install runtime OS packages required by tesseract and pdf conversion
# Install runtime OS packages required for PDF conversion
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    poppler-utils \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user early and make uploads directory
RUN useradd -m -u 1000 appuser && mkdir -p /app/uploads && chown -R appuser:appuser /app
USER appuser

# Copy the virtualenv from builder
COPY --from=builder --chown=appuser:appuser /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy only the necessary application files
COPY --chown=appuser:appuser server.py ./

# Copy the frontend build from the frontend-builder stage into /app/build
COPY --from=frontend-builder --chown=appuser:appuser /workspace/api/build ./build

# Ensure uploads dir exists
RUN mkdir -p uploads && chmod 755 uploads

# Environment variables
ENV FASTAPI_ENV=production

# Expose port and healthcheck
EXPOSE 5040
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:5040/healthz', timeout=3); sys.exit(0 if r.getcode()==200 else 1)"

# Run with uvicorn (non-root user) to serve the FastAPI app
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5040", "--workers", "2"]

