FROM python:3.13.9-slim

# Development image for running the API locally inside Docker with live reload.
WORKDIR /app

# Install system/runtime deps required by pdf2image/tesseract conversions
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    build-essential \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Create a virtualenv for isolated installs
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy dependency manifest and install runtime Python packages into venv
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

# Copy application files (server) and built frontend (if available)
COPY server.py ./
COPY build/web ./build/web

# Create uploads directory and mark as writable
RUN mkdir -p uploads && chmod 755 uploads

ENV FASTAPI_ENV=development

# Expose port for development
EXPOSE 5040

# Run with reload for development. Mount source in docker-compose if desired.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "5040", "--reload"]
