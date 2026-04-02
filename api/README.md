# AI Reception Backend

This directory contains the Laravel 13 backend for AI Reception. It is responsible for:

- accepting and validating applicant uploads
- converting PDFs to images and extracting text with OCR
- classifying documents and queueing uncertain results for manual review
- authenticating reviewers and admins
- serving the built frontend in production

## Important Current Behavior

- API routes are mounted without an `/api` prefix because `bootstrap/app.php` sets `apiPrefix: ''`
- the main public endpoints are `/health`, `/upload`, `/files`, `/download_zip`, `/auth/*`, and `/admin/*`
- local development uses SQLite by default at `database/database.sqlite`
- the scheduled cleanup command runs hourly and removes expired uploads and OCR cache entries

## Requirements

| Dependency | Required version | Notes |
| --- | --- | --- |
| PHP | 8.4+ | Needs `gd`, `pdo_sqlite`, `zip`, `intl` |
| Composer | 2.x | Backend dependency management |
| Tesseract OCR | 5.x | OCR engine used by `OcrService` |
| poppler | recent | `pdftoppm` must be on `PATH` |

Typical package install on Ubuntu:

```bash
sudo apt install tesseract-ocr tesseract-ocr-rus poppler-utils
```

## Local Setup

### Bootstrap the app

```bash
cd api
composer setup
```

That script currently does the following:

- installs Composer dependencies
- copies `.env.example` to `.env` if missing
- generates `APP_KEY`
- runs database migrations

### Run the backend

```bash
cd api
composer dev
```

`composer dev` starts two long-running processes:

- PHP development server on `127.0.0.1:5040`
- `php artisan queue:listen --tries=1`

The frontend dev server in `../web` should be run separately with `pnpm dev`.

### Test the backend

```bash
cd api
composer test
```

## Useful Commands

```bash
# Create an admin user
php artisan admin:create --email=admin@example.com --name="Admin" --role=admin
```

```bash
# Create a reviewer
php artisan admin:create --email=reviewer@example.com --name="Reviewer" --role=reviewer
```

```bash
# Run migrations manually
php artisan migrate
```

```bash
# Trigger cleanup manually
php artisan app:cleanup-old-files
```

## Environment Variables

The defaults live in `.env.example`. The most important settings are below.

### Core application settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ENV` | `local` | Switch to `production` on the server |
| `APP_DEBUG` | `true` | Must be `false` in production |
| `APP_URL` | `http://localhost:5040` | Public base URL |
| `APP_KEY` | generated | Laravel encryption key |

### Auth and sessions

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_DRIVER` | `cookie` | Cookie-based sessions |
| `SESSION_ENCRYPT` | `true` | Encrypts session cookie payload |
| `SESSION_LIFETIME` | `1440` | Minutes before session expiry |
| `SANCTUM_STATEFUL_DOMAINS` | local hosts | Allowed stateful frontend origins |

### Database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DB_CONNECTION` | `sqlite` | Local default |
| `DB_DATABASE` | framework default | SQLite path or database name |

### OCR and file handling

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_FILE_SIZE` | `52428800` | Max single upload in bytes |
| `MAX_FILES_PER_UPLOAD` | `20` | Max files per request |
| `MAX_PAGES_OCR` | `10` | Max PDF pages converted for OCR |
| `PDF_DPI` | `200` | PDF render resolution |
| `IMAGE_MAX_SIZE` | `1800` | Largest image dimension before OCR |
| `TESSERACT_TIMEOUT` | `30` | OCR timeout in seconds |
| `TESSERACT_PSM` | `4` | Page segmentation mode |
| `MAX_TEXT_EXTRACT_LENGTH` | `5000` | OCR text clip limit |
| `CONFIDENCE_THRESHOLD` | `0.95` | Below this goes to review |
| `RATE_LIMIT_PER_MINUTE` | `30` | Upload throttling |
| `MAX_FILE_AGE_DAYS` | `30` | Upload retention |
| `CACHE_TTL_DAYS` | `7` | OCR cache retention |

## Auth Model

The backend uses Laravel Sanctum with stateful cookie sessions.

Current frontend behavior:

- the client sends requests to same-origin paths such as `/auth/login`
- authenticated requests use `credentials: include`
- the app does not rely on a separate frontend API base URL during local development because Vite proxies those paths to port `5040`

Roles:

- `reviewer`: can work documents in the review queue
- `admin`: reviewer permissions plus full administrative access

## Public and Protected Routes

### Public routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `POST` | `/upload` | Upload and classify files |
| `GET` | `/files` | List files for an applicant |
| `GET` | `/files/{id}` | Download one file |
| `DELETE` | `/files/{id}` | Delete one file |
| `GET` | `/download_zip` | Download matched files as ZIP |
| `POST` | `/auth/login` | Start reviewer/admin session |

### Authenticated routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/auth/logout` | End session |
| `POST` | `/auth/refresh` | Refresh active session |
| `GET` | `/auth/me` | Current user and session info |

### Reviewer and admin routes

All `/admin/*` routes require `auth:sanctum` plus the `role:reviewer,admin` middleware.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/review-queue` | List queue items |
| `GET` | `/admin/review-queue/{document}` | Fetch one document |
| `POST` | `/admin/review-queue/{document}/claim` | Claim work item |
| `POST` | `/admin/review-queue/{document}/release` | Return item to queue |
| `POST` | `/admin/review-queue/{document}/resolve` | Accept, override, or reject |
| `GET` | `/admin/review-queue/{document}/audit` | Review history |
| `GET` | `/admin/review-queue/{document}/preview` | Preview image, text, or PDF |

## Review Flow

1. Applicant uploads one or more files with `name` and `lastname`
2. OCR extracts text from PDFs or images
3. `ClassifierService` predicts a category and confidence score
4. High-confidence items remain in the normal uploaded state
5. Low-confidence items are marked `queued` for human review
6. Reviewer or admin claims, resolves, or overrides the classification

Current built-in categories:

- `Udostoverenie`
- `ENT`
- `Lgota`
- `Diplom`
- `Privivka`
- `MedSpravka`
- `Unclassified`

## Storage Layout

Important write locations:

- `database/database.sqlite`: default local database
- `storage/app/uploads`: uploaded files
- `storage/app/cache`: OCR cache files keyed by SHA-256
- `storage/logs`: Laravel, nginx, php-fpm, and scheduler logs in production containers

The scheduled command `app:cleanup-old-files` is registered in `routes/console.php` and runs hourly.

## Architecture Notes

High-level backend components:

- `app/Services/OcrService.php`: PDF conversion, image preprocessing, OCR, OCR cache
- `app/Services/ClassifierService.php`: keyword and fuzzy classification logic
- `app/Services/DocumentService.php`: document persistence and retrieval
- `app/Services/ReviewService.php`: claim/release/resolve workflow
- `app/Console/Commands/CreateAdminUser.php`: reviewer/admin bootstrap command
- `app/Console/Commands/CleanupOldFiles.php`: retention cleanup

Production serving model:

- host nginx handles TLS
- container nginx listens on port `5040`
- php-fpm handles Laravel execution
- the built frontend is copied into `public/build` by the root `Dockerfile`

## Troubleshooting

- If uploads fail only on Windows, check whether PHP temp uploads and `storage/app/uploads` live on different volumes; plain file moves across volumes have caused issues in this repo
- If OCR returns empty text, verify `tesseract` and `pdftoppm` are installed and reachable from the PHP process environment
- If login appears to succeed but subsequent requests are anonymous, re-check `SANCTUM_STATEFUL_DOMAINS`, `APP_URL`, and cookie settings
- If the review queue is not progressing, confirm the queue worker from `composer dev` is running
- If production serves JSON instead of the SPA, confirm the frontend build exists in `public/build/index.html`
