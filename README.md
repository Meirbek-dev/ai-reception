# AI Reception

AI Reception is an OCR-assisted intake system for university admissions. Applicants upload document batches, the backend extracts text with Tesseract, documents are classified automatically, and low-confidence results are routed to a reviewer queue.

This repository contains the full stack application:

- `web/`: React 19 frontend built with Vite and TanStack Router
- `api/`: Laravel 13 backend with SQLite storage, OCR, classification, and review workflows
- `Dockerfile`: production image that builds the frontend and serves it from Laravel
- `docker-compose.yml`: production container orchestration with persistent volumes
- `nginx.conf`: example host nginx config for TLS termination

## Architecture at a Glance

| Layer | Stack | Notes |
| --- | --- | --- |
| Frontend | React 19, TypeScript, Vite 8 | Upload UI, reviewer UI, auth flows |
| Backend | PHP 8.4, Laravel 13, Sanctum | File handling, auth, review queue, scheduling |
| OCR | Tesseract OCR, poppler `pdftoppm` | PDF-to-image conversion and text extraction |
| Storage | SQLite + local filesystem | Database in `api/database/database.sqlite`, files in `storage/app` |
| Production runtime | Docker, nginx, php-fpm, Supervisor | Single container serving API and built SPA |

## Repository Layout

```text
ai-reception-v2/
|-- api/
|   |-- app/
|   |-- config/
|   |-- database/
|   |-- routes/
|   `-- tests/
|-- web/
|   |-- src/
|   `-- public/
|-- Dockerfile
|-- docker-compose.yml
|-- nginx.conf
`-- DEPLOY.md
```

## Quick Start for New Developers

### 1. Install prerequisites

Required locally:

- Node.js 20+ and `pnpm`
- PHP 8.4+
- Composer 2.x
- Tesseract OCR
- poppler utilities with `pdftoppm` on `PATH`

PHP extensions required by the backend:

- `gd`
- `pdo_sqlite`
- `zip`
- `intl`

Platform notes:

```bash
# Debian / Ubuntu
sudo apt install tesseract-ocr tesseract-ocr-rus poppler-utils
```

```bash
# macOS (Homebrew)
brew install tesseract poppler
```

Windows:

- Install Tesseract from the UB Mannheim build and add it to `PATH`
- Install poppler with `winget install poppler`
- Laravel Herd or another local PHP environment is recommended

### 2. Set up the backend

```bash
cd api
composer setup
```

`composer setup` performs the backend bootstrap:

- installs Composer dependencies
- creates `api/.env` from `.env.example` if needed
- generates the Laravel app key
- runs database migrations against `api/database/database.sqlite`

### 3. Start the backend services

```bash
cd api
composer dev
```

This starts:

- the Laravel development server on `http://127.0.0.1:5040`
- the queue worker used for background jobs

Important: the current development workflow is `composer dev`. The root `start.ps1` file is legacy and does not reflect the Laravel backend.

### 4. Start the frontend

In a second terminal:

```bash
cd web
pnpm install
pnpm dev
```

The frontend runs on `http://localhost:5173`.

During development, Vite proxies application requests such as `/upload`, `/files`, `/auth`, and `/admin` to the backend on port `5040`, so the browser talks to the frontend origin while the proxy forwards requests to Laravel.

### 5. Create an admin user

```bash
cd api
php artisan admin:create --email=admin@example.com --name="Admin" --role=admin
```

If `--password` is omitted, the command prompts for one securely.

### 6. Open the app

- Frontend: `http://localhost:5173`
- Backend health check: `http://127.0.0.1:5040/health`

## Day-to-Day Commands

```bash
# Backend tests
cd api
composer test
```

```bash
# Frontend tests
cd web
pnpm test
```

```bash
# Frontend production build
cd web
pnpm build
```


## Where to Look Next

- See `api/README.md` for backend architecture, environment variables, and API details
- See `DEPLOY.md` for Docker, nginx, TLS, and production rollout steps
- See `PRESENTATION_SPEECH.md` for the non-technical project presentation script

## Common Pitfalls

- If OCR fails immediately, verify that both `tesseract` and `pdftoppm` are available on your shell `PATH`
- If login or upload requests fail in the frontend, confirm the backend is running on port `5040`
- If you are on Windows and uploads behave inconsistently, avoid cross-volume temp and storage configurations; this repo has previously hit file move issues when PHP temp files and Laravel storage live on different volumes
