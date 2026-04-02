# Production multi-stage Dockerfile for PHP + Laravel
# 1) frontend-builder: build the React web app with pnpm
# 2) runtime: PHP 8.4 + Composer + OS packages + Laravel

# --- Frontend builder -------------------------------------------------------
FROM node:25-slim AS frontend-builder
WORKDIR /workspace

RUN npm i -g pnpm@latest || true

COPY web/package.json web/pnpm-lock.yaml* ./web/
COPY web/ ./web/

WORKDIR /workspace/web
RUN CI=true pnpm install --frozen-lockfile && \
    CI=true pnpm run build

# --- PHP runtime image -------------------------------------------------------
FROM php:8.4-fpm-alpine AS runtime
WORKDIR /app

# Install OS packages
RUN apk add --no-cache \
    # PDF -> image conversion (pdftoppm)
    poppler-utils \
    # OCR engine
    tesseract-ocr \
    tesseract-ocr-data-rus \
    tesseract-ocr-data-kaz \
    # Nginx + Supervisor to run both php-fpm and nginx in one container
    nginx \
    supervisor \
    # PHP extensions
    libpng-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    icu-dev \
    zip \
    libzip-dev \
    sqlite \
    sqlite-dev \
    curl

# Build PHP extensions
RUN docker-php-ext-configure gd --with-freetype --with-jpeg && \
    docker-php-ext-install -j$(nproc) \
        gd \
        pdo_sqlite \
        zip \
        intl \
        pcntl \
        opcache

# Composer
COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

# Copy Laravel application source
COPY api/ /app/

# Install PHP dependencies (production, no dev)
RUN composer install --no-dev --optimize-autoloader --no-interaction

# Copy built frontend into Laravel's public/build for serving
COPY --from=frontend-builder /workspace/web/dist /app/public/build

# Storage directories (will be replaced by volume mounts in production)
RUN mkdir -p \
    /app/storage/app/uploads \
    /app/storage/app/cache \
    /app/storage/logs \
    /app/storage/framework/sessions \
    /app/storage/framework/views \
    /app/storage/framework/cache \
    /app/bootstrap/cache \
    /app/database

# Create non-root user
RUN addgroup -S appuser && adduser -S -G appuser appuser
RUN chown -R appuser:appuser /app/storage /app/bootstrap/cache /app/database

# Nginx config
COPY api/docker/nginx.conf /etc/nginx/http.d/default.conf

# Supervisor config  (runs php-fpm + nginx + scheduler)
COPY api/docker/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Artisan-generated caches (speeds up boot)
RUN php artisan config:cache && php artisan route:cache && php artisan view:cache

USER appuser

EXPOSE 5040

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
