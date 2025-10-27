Deployment guide for AI Reception# Deployment guide for ai-reception

This document describes how to deploy the application to an Ubuntu server and expose it at:This document explains how to build and deploy the project to an Ubuntu server (accessible via SSH at `user@192.168.12.35`) and serve it on a domain (for example `ai-reception.tou.edu.kz`) using Docker, docker-compose, and nginx.

- http://192.168.12.35:5040/ (direct container port)## Assumptions

- https://ai-reception.tou.edu.kz/ (via nginx reverse proxy + TLS)

- You have Docker and docker-compose installed on the server (or can install them).

Prerequisites on the Ubuntu server (assume you can SSH to user@192.168.12.35):- You control DNS for your chosen domain and it points to the server's public IP.

- Ports 80 and 443 are open.

- Docker and Docker Compose (v2) installed- You have SSH access: `ssh user@192.168.12.35`.

- nginx installed (or you can run nginx in a container)

- git (optional) and enough disk space## Quick overview

- Ports 80 and 443 open in the firewall for Let's Encrypt

1. Build the frontend locally so files land in `api/build/web`.

Quick steps1. Copy built assets and `api/` to the server (or push to a registry and pull on the server).

1. Compute a sensible `UVICORN_WORKERS` value on the server and start the service via `docker compose`.

1. Copy the repository to the server (or pull from git):1. Configure host nginx to terminate TLS and reverse-proxy to the backend container (127.0.0.1:5040).

````pwsh---

ssh user@192.168.12.35

# on server## Local build (developer machine)

git clone <your-repo-url> ai-reception

cd ai-receptionInstall dependencies and build the frontend:



sudo ufw reload
# AI Reception — Deployment Guide

This document explains how to build and deploy the project to an Ubuntu server (accessible via SSH at `user@192.168.12.35`) and serve it on a domain (for example `ai-reception.tou.edu.kz`) using Docker, docker-compose, and nginx.

Targets

- Direct container port: `http://192.168.12.35:5040/`
- Public domain (TLS): `https://ai-reception.tou.edu.kz/`

Assumptions

- You control DNS for the chosen domain and it points to the server's public IP.
- Ports 80 and 443 can be opened on the server (for Let's Encrypt / HTTPS).
- Docker, docker-compose (v2 plugin) and nginx can be installed on the server.

Overview

The repo contains a production multi-stage Dockerfile (`Dockerfile.production`) that builds the frontend and backend into a single image and a top-level `docker-compose.yml` that publishes port 5040 on the host by default.

Quick deploy (recommended)

1. Clone the repository on the server:

```pwsh
ssh user@192.168.12.35
# on server
git clone <your-repo-url> ai-reception
cd ai-reception
````

2. Build and start production containers (from repo root):

```pwsh
# on server, inside repo root
docker compose up -d --build --remove-orphans
```

3. Verify the backend is reachable locally on the host:

```pwsh
# on server
curl -f http://127.0.0.1:5040/healthz
```

4. Configure nginx to proxy requests for `ai-reception.tou.edu.kz` to `127.0.0.1:5040` using the provided `nginx.conf` as a starting point.

Example nginx steps (on server):

```pwsh
sudo cp nginx.conf /etc/nginx/sites-available/ai-reception
sudo ln -sf /etc/nginx/sites-available/ai-reception /etc/nginx/sites-enabled/ai-reception
sudo nginx -t
sudo systemctl reload nginx
```

5. Obtain TLS certs with Certbot (nginx plugin recommended):

```pwsh
sudo apt update
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ai-reception.tou.edu.kz
```

6. Open firewall ports (ufw example):

```pwsh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw allow 5040/tcp
sudo ufw enable
```

Notes and recommendations

- If you want nginx to be the only publicly exposed service, the `docker-compose.yml` default bind is `0.0.0.0:5040:5040`. To restrict the backend to localhost only, run:

```pwsh
BIND_HOST=127.0.0.1 docker compose up -d --build
```

then nginx (running on the host) can proxy to `http://127.0.0.1:5040`.

- The production Dockerfile copies frontend build artifacts from the frontend stage into `/app/build/web`. The backend serves static files from that path if present.

- Compute a conservative number of Uvicorn workers on the server and export it before starting compose. Example heuristic:

```pwsh
CPU_THREADS=$(nproc --all)
UVICORN_WORKERS=$(( CPU_THREADS / 4 ))
if [ "$UVICORN_WORKERS" -lt 2 ]; then UVICORN_WORKERS=2; fi
export UVICORN_WORKERS
docker compose up -d --build
```

- To renew TLS certs automatically, ensure `certbot` timers are enabled (usually installed by the package). You can test renewal with `sudo certbot renew --dry-run`.

Troubleshooting

- Check container logs: `sudo docker logs ai-reception`.
- Inspect service status: `docker compose ps`.
- If the healthcheck fails, curl the health endpoint directly inside the container or on the host.
- If the frontend is not served, confirm `api/build/web` exists in the image or copy builds from your workstation.

Optional: systemd helper

Create `/etc/systemd/system/ai-reception.service` to automatically start the docker compose stack on boot. Example file is optional and can be provided on request.

If you'd like, I can: add a small `scripts/` folder with build-and-deploy helper scripts, add a systemd unit, or prepare an `nginx` site file pre-filled with your real cert paths.

- If you run nginx in a container, ensure `proxy_pass` points to the host networking or to the service container via Docker network name and the compose setup is adjusted accordingly.export UVICORN_WORKERS=${UVICORN_WORKERS:-4}

UVICORN_WORKERS=$UVICORN_WORKERS sudo docker compose up --build -d

- The production Dockerfile copies built frontend assets into `/app/build/web`. The nginx config above proxies all requests to the backend; the backend serves static files from `/app/build/web` if present.```

- For zero-downtime deployments, consider using `docker compose pull && docker compose up -d --no-deps --build --remove-orphans ai-reception`.You can also override inline:

If you want, I can also create a small systemd unit or a `docker-compose.override.yml` to make common actions easier.```bash
UVICORN_WORKERS=32 sudo docker compose up --build -d

````

If you changed `api/docker-compose.yml` to bind to localhost by default, you can publish to all interfaces with an environment override:

```bash
# Publish backend on all interfaces (not recommended for production without proxy)
BIND_HOST=0.0.0.0 UVICORN_WORKERS=4 sudo docker compose up -d --build
````

Development container

If you want to run the development image locally (uses `api/Dockerfile.dev`) it runs uvicorn with `--reload`. Build and run it with:

```bash
cd api
docker build -f Dockerfile.dev -t ai-reception-dev .
docker run --rm -p 5040:5040 -v $(pwd):/app ai-reception-dev
```

When running the dev container, mounting your repo into `/app` will let the uvicorn `--reload` watch for changes.

---

### Full server setup (Ubuntu) — explicit commands

Run these commands on your Ubuntu server (user@192.168.12.35). They assume sudo privileges.

1. Install Docker, docker-compose plugin and nginx

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release nginx

# Official convenience script to install Docker Engine
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Optional: docker compose plugin (on newer Ubuntu/Docker)
sudo apt install -y docker-compose-plugin

sudo systemctl enable --now docker
sudo systemctl enable --now nginx
```

2. Create a webroot used by Certbot for HTTP challenges

```bash
sudo mkdir -p /var/www/letsencrypt
sudo chown -R $USER:$USER /var/www/letsencrypt
```

3. Install Certbot and obtain a certificate (webroot or nginx plugin)

```bash
sudo apt install -y certbot python3-certbot-nginx

# Using nginx plugin (automatically edits nginx and reloads)
sudo certbot --nginx -m you@example.com --agree-tos -d ai-reception.tou.edu.kz

# OR webroot method (explicit placement)
sudo certbot certonly --webroot -w /var/www/letsencrypt -m you@example.com --agree-tos -d ai-reception.tou.edu.kz

# Test renewal
sudo certbot renew --dry-run
```

4. Copy the repository and built frontend (from your workstation)

On your workstation:

```bash
pnpm install
pnpm run build:frontend
scp -r api user@192.168.12.35:~/ai-reception
```

5. Place the nginx site config and enable it

```bash
sudo cp ~/ai-reception/api/nginx.conf /etc/nginx/sites-available/ai-reception
sudo ln -sf /etc/nginx/sites-available/ai-reception /etc/nginx/sites-enabled/ai-reception
sudo nginx -t
sudo systemctl reload nginx
```

6. Open firewall ports (if using ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

7. Start the application with docker compose

```bash
cd ~/ai-reception/api
CPU_THREADS=$(nproc --all)
UVICORN_WORKERS=$(( CPU_THREADS / 4 ))
if [ "$UVICORN_WORKERS" -lt 2 ]; then UVICORN_WORKERS=2; fi
echo "Computed UVICORN_WORKERS=$UVICORN_WORKERS (CPU_THREADS=$CPU_THREADS)"

export UVICORN_WORKERS=${UVICORN_WORKERS}
sudo docker compose up -d --build
```

Notes

- If you want nginx to be the only exposed service, set the compose publish to `127.0.0.1:5040:5040` and keep nginx proxy_pass to `http://127.0.0.1:5040`.
- If you prefer docker-managed nginx, create a separate nginx container and attach it to the same docker network as the backend (adjust `proxy_pass` accordingly).

1. Configure host nginx to terminate TLS and proxy to the container

Use the repo `api/nginx.conf` as a starting point, or create `/etc/nginx/sites-available/ai-reception` with the following (replace cert paths after obtaining certs):

```nginx
server {
    listen 80;
    server_name ai-reception.tou.edu.kz;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ai-reception.tou.edu.kz;

    ssl_certificate /etc/letsencrypt/live/ai-reception.tou.edu.kz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai-reception.tou.edu.kz/privkey.pem;

    client_max_body_size 200M;

    location / {
        proxy_pass http://127.0.0.1:5040;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 600;
        proxy_send_timeout 600;
        proxy_read_timeout 600;
        send_timeout 600;
    }
}
```

Enable and test nginx:

```bash
sudo ln -s /etc/nginx/sites-available/ai-reception /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

1. Obtain TLS certificate with certbot

```bash
sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ai-reception.tou.edu.kz
```

1. Verify health

```bash
curl -I https://ai-reception.tou.edu.kz/healthz
```

1. Optional: systemd unit (auto-start on boot)

Create `/etc/systemd/system/ai-reception.service` with something like:

```ini
[Unit]
Description=AI Reception docker-compose
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/user/ai-reception/api
Environment=UVICORN_WORKERS=32
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

Then enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-reception.service
```

---

## Notes and troubleshooting

- The backend uses Tesseract and pdf2image (CPU-bound). No GPU is required.
- With many CPU threads and plenty of RAM, tune `UVICORN_WORKERS` upward carefully and monitor memory with `docker stats` and `htop`.
- If uploads are large, increase `client_max_body_size` in nginx.
- If the container healthcheck fails, inspect logs: `sudo docker logs ai-reception` and check the `/healthz` route.
- To change workers after deployment: restart compose with the desired env value: `UVICORN_WORKERS=24 sudo docker compose up -d --build`.

If you'd like, I can add a small `scripts/` folder that wraps build/copy/start steps and a sample systemd unit pre-filled with computed workers.
