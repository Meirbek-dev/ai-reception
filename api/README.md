# AI Reception — Laravel API

OCR-based document classification system with a human-in-the-loop review queue.
PHP 4+ / Laravel 13 backend. Replaces the previous FastAPI (Python) implementation.

---

## Table of Contents

1. [Requirements](#requirements)
2. [Local Development](#local-development)
3. [Environment Variables](#environment-variables)
4. [Creating Users](#creating-users)
5. [API Reference](#api-reference)
6. [Docker / Production Deployment](#docker--production-deployment)
7. [Architecture](#architecture)

---

## Requirements

### Local development

| Tool | Version |
|------|---------|
| PHP | 8.4+ (with `gd`, `pdo_sqlite`, `zip`, `intl` extensions) |
| Composer | 2.x |
| Tesseract OCR | 5.x |
| poppler-utils | any recent (`pdftoppm` must be in `PATH`) |

Install system dependencies on **Debian/Ubuntu**:

```bash
sudo apt install tesseract-ocr tesseract-ocr-rus tesseract-ocr-kaz poppler-utils
```

On **macOS** (Homebrew):

```bash
brew install tesseract tesseract-lang poppler
```

On **Windows** (with [Laravel Herd](https://herd.laravel.com/)):

- Install Tesseract via [UB Mannheim installer](https://github.com/UB-Mannheim/tesseract/wiki); add to `PATH`
- Install poppler via winget: `winget install poppler`

---

## Local Development

### 1. Install dependencies and set up the app

```bash
cd api

# Install PHP and JS dependencies, generate app key, run migrations, build frontend
composer setup
```

This runs: `composer install` → `key:generate` → `migrate` → `npm install` → `npm run build`.

### 2. Start all processes (server + queue + Vite)

```bash
composer dev
```

This starts three concurrent processes:

| Process | What it does | Port |
|---------|-------------|------|
| `php artisan serve --port=5040` | Laravel dev server | 5040 |
| `php artisan queue:listen` | Job queue worker | — |

The API is at **<http://localhost:5040/api/>**

> **Note:** The React frontend in `web/` talks to `http://localhost:5040` for API calls. Make sure that port is free before running `composer dev`.

### 3. Create your first admin user

```bash
php artisan admin:create --email=admin@example.com --name="Admin" --role=admin
```

You will be prompted for a password if `--password` is not supplied.

### 4. Run migrations manually (if needed)

```bash
php artisan migrate
```

### 5. Run tests

```bash
composer test
```

---

## Environment Variables

Copy `.env.example` to `.env` (done automatically by `composer setup`) and adjust as needed.

### Core Laravel settings

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_KEY` | *(generated)* | Encryption key — never share |
| `APP_ENV` | `local` | `local` / `production` |
| `APP_DEBUG` | `true` | Disable in production |
| `APP_URL` | `http://localhost:5040` | Base URL |

### Session / Auth

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_DRIVER` | `cookie` | Keep as `cookie` for stateless API |
| `SESSION_LIFETIME` | `1440` | Session lifetime in minutes (24 h) |
| `SESSION_ENCRYPT` | `true` | Encrypt session cookie |
| `SANCTUM_STATEFUL_DOMAINS` | `localhost,localhost:5173,localhost:5040` | Comma-separated origins that receive session cookies |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_CONNECTION` | `sqlite` | `sqlite` / `mysql` / `pgsql` |
| `DB_DATABASE` | *(path to sqlite file)* | Absolute path for SQLite; DB name for MySQL/PgSQL |

### Application settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_FILE_SIZE` | `52428800` | Max upload size in bytes (50 MB) |
| `MAX_FILES_PER_UPLOAD` | `20` | Max files per upload request |
| `MAX_PAGES_OCR` | `10` | Max PDF pages to OCR |
| `RATE_LIMIT_PER_MINUTE` | `30` | Upload rate limit per IP |
| `MAX_FILE_AGE_DAYS` | `30` | Uploaded files older than this are deleted by the cleanup job |
| `CACHE_TTL_DAYS` | `7` | OCR cache TTL |
| `TESSERACT_TIMEOUT` | `30` | Tesseract per-image timeout (seconds) |
| `TESSERACT_PSM` | `4` | Tesseract page segmentation mode |
| `PDF_DPI` | `200` | DPI for PDF→image conversion |
| `IMAGE_MAX_SIZE` | `1800` | Max image dimension (pixels) before OCR |
| `CONFIDENCE_THRESHOLD` | `0.95` | Documents below this confidence go to the review queue |

---

## Creating Users

```bash
# Create an admin
php artisan admin:create --email=admin@example.com --name="Admin User" --role=admin

# Create a reviewer
php artisan admin:create --email=reviewer@example.com --name="Reviewer" --role=reviewer

# Non-interactive (CI / scripts)
php artisan admin:create --email=ci@example.com --password=secret --role=reviewer
```

Roles:

| Role | Access |
|------|--------|
| `reviewer` | Can view and action documents in the review queue |
| `admin` | Full access (superset of reviewer) |

---

## API Reference

All endpoints are under `/api/`. The frontend SPA must:

1. `GET /sanctum/csrf-cookie` to obtain the XSRF token
2. Send the `X-XSRF-TOKEN` header on every mutating request
3. Include `withCredentials: true` on all requests

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | — | Log in; sets session cookie |
| POST | `/api/auth/logout` | ✓ | Log out; clears session |
| POST | `/api/auth/refresh` | ✓ | Refresh session |
| GET | `/api/auth/me` | ✓ | Current user + session info |

**Login request:**

```json
{ "email": "admin@example.com", "password": "...", "remember_me": false }
```

**Login response:**

```json
{
  "message": "Успешный вход",
  "user": {
    "id": "...", "email": "...", "display_name": "...",
    "role": "admin", "is_active": true, "last_login_at": "..."
  },
  "session": { "expires_at": "...", "remember_me": false }
}
```

---

### File Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | — | Health check |
| POST | `/api/upload` | — | Upload + classify files (rate-limited) |
| GET | `/api/files` | — | List files (requires `?name=&lastname=`) |
| GET | `/api/files/{id}` | — | Download single file |
| GET | `/api/download_zip` | — | Download all matching files as ZIP |
| DELETE | `/api/files/{id}` | — | Delete a file |

**Upload request** (`multipart/form-data`):

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Applicant first name |
| `lastname` | string | Applicant last name |
| `files[]` | file(s) | PDF, JPG, PNG — up to 20 files, 50 MB each |

**Upload response:**

```json
{
  "success":      [{ "id": "...", "originalName": "...", "category": "Diplom", "confidence": 0.95 }],
  "unclassified": [{ "id": "...", "category": "Unclassified" }],
  "failed":       [{ "filename": "bad.pdf", "error": "..." }],
  "summary":      { "total": 3, "successful": 2, "unclassified": 0, "failed": 1 }
}
```

Document categories: `Udostoverenie`, `ENT`, `Lgota`, `Diplom`, `Privivka`, `MedSpravka`, `Unclassified`

---

### Admin / Review Queue

All endpoints require authentication + `role:reviewer,admin`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/review-queue` | List documents; `?status=queued&limit=50&offset=0` |
| POST | `/api/admin/review-queue/{id}/claim` | Claim a document for review |
| POST | `/api/admin/review-queue/{id}/release` | Release back to queue |
| POST | `/api/admin/review-queue/{id}/resolve` | Resolve with final category |
| GET | `/api/admin/review-queue/{id}` | Get document details |
| GET | `/api/admin/review-queue/{id}/audit` | Get audit trail |
| GET | `/api/admin/review-queue/{id}/preview` | Document preview (PDF inline / image base64) |

**Resolve request:**

```json
{
  "final_category":     "Diplom",
  "applicant_name":     "John",
  "applicant_lastname": "Doe",
  "comment":            "Corrected from MedSpravka"
}
```

---

## Docker / Production Deployment

### Build and run

```bash
# From the repo root
docker compose up --build -d
```

The container runs on **port 5040** and serves both the API and the built React frontend.

### First run inside the container

```bash
# Migrations run automatically via Dockerfile, but can be triggered manually:
docker exec ai-reception php artisan migrate --force

# Create the first admin user:
docker exec -it ai-reception php artisan admin:create \
  --email=admin@yourdomain.com \
  --name="Administrator" \
  --role=admin
```

### What runs inside the container

Managed by **Supervisor**:

| Process | Role |
|---------|------|
| `php-fpm` | PHP request handler |
| `nginx` | Reverse proxy on port 5040, serves static assets |
| `scheduler` | Runs `php artisan schedule:run` every 60 s |

### Volumes

| Named volume | Container path | Purpose |
|-------------|---------------|---------|
| `ai_reception_uploads` | `/app/storage/app/uploads` | Uploaded documents |
| `ai_reception_db` | `/app/database` | SQLite database |
| `ai_reception_ocrcache` | `/app/storage/app/cache` | OCR cache (safe to drop) |

### Host nginx (HTTPS termination)

```nginx
server {
    listen 443 ssl;
    server_name ai-reception.tou.edu.kz;

    ssl_certificate     /etc/nginx/ssl/ai-reception.tou.edu.kz.crt;
    ssl_certificate_key /etc/nginx/ssl/ai-reception.tou.edu.kz.key;

    client_max_body_size 55M;

    location / {
        proxy_pass         http://127.0.0.1:5040;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
}
```

### Production `.env` checklist

```dotenv
APP_ENV=production
APP_DEBUG=false
APP_URL=https://ai-reception.tou.edu.kz
APP_KEY=base64:<run: php artisan key:generate --show>

SESSION_DRIVER=cookie
SESSION_ENCRYPT=true

SANCTUM_STATEFUL_DOMAINS=ai-reception.tou.edu.kz

RATE_LIMIT_PER_MINUTE=60
MAX_FILE_AGE_DAYS=90
```

Cache config/routes after any `.env` or code change:

```bash
php artisan config:cache && php artisan route:cache && php artisan view:cache
```

---

## Architecture

```
api/
├── app/
│   ├── Console/Commands/
│   │   ├── CleanupOldFiles.php          # Hourly: delete old uploads + expired OCR cache
│   │   └── CreateAdminUser.php          # php artisan admin:create
│   ├── Http/
│   │   ├── Controllers/
│   │   │   ├── AuthController.php       # login / logout / refresh / me
│   │   │   ├── FileController.php       # upload / list / download / delete / health
│   │   │   └── Admin/
│   │   │       └── ReviewQueueController.php  # claim / release / resolve / preview / audit
│   │   ├── Middleware/
│   │   │   └── RequireRole.php          # role:reviewer,admin
│   │   └── Resources/
│   │       ├── DocumentResource.php
│   │       ├── ReviewActionResource.php
│   │       └── UserResource.php
│   ├── Models/
│   │   ├── Document.php
│   │   ├── DocumentText.php
│   │   ├── ReviewAction.php
│   │   └── User.php
│   ├── Providers/
│   │   └── AppServiceProvider.php       # Rate limiter (30 req/min per IP on /upload)
│   └── Services/
│       ├── ClassifierService.php        # Keyword exact-match + token-set-ratio fuzzy fallback
│       ├── DocumentService.php          # Upload pipeline, file listing/download/delete/zip
│       ├── OcrService.php               # pdftoppm + Tesseract + SHA-256 filesystem cache
│       └── ReviewService.php            # Claim/release/resolve with DB transactions + audit log
├── database/migrations/                 # 6 migrations
├── routes/
│   ├── api.php                          # 20 API endpoints
│   ├── web.php                          # SPA fallback (serves React index.html)
│   └── console.php                      # Hourly scheduler
└── docker/
    ├── nginx.conf                        # Port 5040
    └── supervisord.conf                  # php-fpm + nginx + scheduler
```

### Upload flow

```
POST /api/upload
  │
  ├─ Validate file type + size
  ├─ OcrService::extractText()
  │    ├─ SHA-256 cache hit → return cached text
  │    ├─ PDF → pdftoppm → pages → Tesseract (sequential)
  │    └─ Image → greyscale + resize → Tesseract
  ├─ ClassifierService::classify()
  │    ├─ Exact keyword match (fast path)
  │    └─ Token-set ratio fuzzy match (fallback, threshold 60)
  ├─ confidence ≥ 0.95 → status = uploaded  (no review needed)
  │   confidence < 0.95 → status = queued   (→ review queue)
  ├─ Write file: storage/app/uploads/{name}_{lastname}_{category}_{idx}_{uuid}.{ext}
  └─ Insert Document + DocumentText rows
```

### Review workflow

```
GET  /admin/review-queue          → list queued documents
POST /admin/review-queue/{id}/claim   → queued → in_review (locked to reviewer)
POST /admin/review-queue/{id}/resolve → in_review → resolved
     action = accept   if final_category == predicted
     action = override if final_category != predicted
POST /admin/review-queue/{id}/release → in_review → queued (give back)

Every state change inserts a ReviewAction row (full audit trail).
```
