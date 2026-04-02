# AI Reception Deployment Guide

This guide documents the current production deployment model in this repository:

- a single Docker image builds the React frontend and serves it from Laravel
- `docker compose` runs the container with persistent volumes
- host nginx terminates TLS and proxies requests to the container on port `5040`

## Production Topology

```text
Browser
  -> host nginx :443
  -> proxy_pass http://127.0.0.1:5040
  -> Docker container
     -> nginx :5040
     -> php-fpm
     -> Laravel app + built frontend
```

Persistent data is stored in Docker volumes declared by `docker-compose.yml`:

- `ai_reception_uploads`: uploaded files
- `ai_reception_db`: SQLite database
- `ai_reception_ocrcache`: OCR cache

## Before You Start

Prepare the following:

- an Ubuntu server with Docker Engine and Docker Compose v2
- host nginx installed on the server
- DNS pointed at the server for your production domain
- ports `80` and `443` open through the firewall
- access to edit `api/.env` before the first deploy

Important current behavior:

- the compose file publishes `5040:5040` on all interfaces by default
- the container health check targets `http://127.0.0.1:5040/api/health`, but the Laravel app currently exposes the health endpoint at `/health`
- the Docker image currently installs Russian Tesseract data; if you need Kazakh OCR in production, extend the Dockerfile before deployment

## 1. Install server dependencies

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx
curl -fsSL https://get.docker.com | sh
sudo systemctl enable --now docker
sudo systemctl enable --now nginx
```

Optional but recommended:

```bash
sudo usermod -aG docker $USER
newgrp docker
```

## 2. Clone the repository

```bash
cd ~
git clone <your-repository-url> ai-reception-v2
cd ai-reception-v2
```

## 3. Configure production environment

Create or update `api/.env` on the server. The compose file loads this file directly.

Minimum settings to verify:

```dotenv
APP_ENV=production
APP_DEBUG=false
APP_URL=https://your-domain.example
SESSION_DRIVER=cookie
SESSION_ENCRYPT=true
SANCTUM_STATEFUL_DOMAINS=your-domain.example
```

If you keep SQLite in production, make sure the database volume is mounted and Laravel can write to `database/database.sqlite` inside the container.

## 4. Build and start the application

From the repository root:

```bash
docker compose up -d --build --remove-orphans
```

Then verify the container is healthy enough to answer requests:

```bash
docker compose ps
curl -f http://127.0.0.1:5040/health
```

Note: because the compose health check still uses `/api/health`, `docker compose ps` may report the service as unhealthy even when the application responds correctly on `/health`. Update that health check in infrastructure code when you want container status to reflect the real endpoint.

## 5. Configure host nginx

The repository root contains an example `nginx.conf` for host-level TLS termination.

Install it as a site:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/ai-reception
sudo ln -sf /etc/nginx/sites-available/ai-reception /etc/nginx/sites-enabled/ai-reception
sudo nginx -t
sudo systemctl reload nginx
```

Before enabling it, update these values in the config:

- `server_name`
- certificate file paths
- optional filesystem root if you serve anything directly from the host

The provided config proxies application routes like `/upload`, `/files`, `/auth`, `/admin`, and `/health` to the container while leaving TLS termination at the host.

## 6. Obtain TLS certificates

Using the nginx Certbot plugin:

```bash
sudo certbot --nginx -d your-domain.example
```

Check renewal:

```bash
sudo certbot renew --dry-run
```

## 7. Lock down network exposure

If host nginx is the intended public entry point, do not leave port `5040` broadly exposed unless you need direct access for debugging.

Recommended options:

- restrict access to port `5040` with your firewall
- or change the compose port mapping to `127.0.0.1:5040:5040`

Example firewall setup with UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw deny 5040/tcp
sudo ufw enable
```

## Updating the Deployment

For a standard redeploy:

```bash
cd ~/ai-reception-v2
git pull
docker compose up -d --build --remove-orphans
```

Useful operational commands:

```bash
docker compose logs -f ai-reception
```

```bash
docker compose exec ai-reception php artisan migrate --force
```

```bash
docker volume ls | grep ai_reception
```

## Troubleshooting

- If the container starts but the site is blank, check that the frontend build was copied into `/app/public/build` during the Docker build
- If uploads fail in production, inspect permissions on `/app/storage` and the mounted upload volume
- If OCR returns poor results or misses Kazakh text, update the Dockerfile to install the required Tesseract language data and rebuild
- If host nginx returns `502`, verify the container is listening on `127.0.0.1:5040` and inspect both host nginx logs and container logs
- If auth cookies do not persist, verify `APP_URL`, `SESSION_DOMAIN`, and `SANCTUM_STATEFUL_DOMAINS` match the public hostname exactly

## Deployment Checklist

- domain resolves to the server
- `api/.env` is present and production-safe
- container responds on `/health`
- nginx config points at the correct domain and cert paths
- TLS certificate is installed and renews successfully
- uploads, database, and OCR cache volumes persist across restarts
