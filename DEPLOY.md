# Deployment guide for ai-reception

This document explains how to build and deploy the project to an Ubuntu server (accessible via SSH at `user@192.168.12.35`) and serve it on a domain (for example `ai-reception.tou.edu.kz`) using Docker, docker-compose, and nginx.

## Assumptions

- You have Docker and docker-compose installed on the server (or can install them).
- You control DNS for your chosen domain and it points to the server's public IP.
- Ports 80 and 443 are open.
- You have SSH access: `ssh user@192.168.12.35`.

## Quick overview

1. Build the frontend locally so files land in `api/build/web`.
1. Copy built assets and `api/` to the server (or push to a registry and pull on the server).
1. Compute a sensible `UVICORN_WORKERS` value on the server and start the service via `docker compose`.
1. Configure host nginx to terminate TLS and reverse-proxy to the backend container (127.0.0.1:5040).

---

## Local build (developer machine)

Install dependencies and build the frontend:

```bash
pnpm install
pnpm run build:frontend
```

Optional: run the full build/type check:

```bash
pnpm run build:all
```

The frontend build output will be placed in `api/build/web` and served by the backend image.

---

## Prepare server and deploy (recommended flow)

1. Copy project artifacts to the server

```bash
# From project root on your workstation
scp -r api user@192.168.12.35:~/ai-reception
# or copy the whole repo if you prefer
scp -r . user@192.168.12.35:~/ai-reception
```

1. SSH to the server and compute UVICORN_WORKERS (conservative heuristic)

With a many-thread machine (you indicated ~128 threads), each worker consumes memory. A conservative heuristic is:

```text
workers = max(2, floor(CPU_THREADS / 4))
```

Run this on the server to pick a starting value:

```bash
ssh user@192.168.12.35
cd ~/ai-reception/api
CPU_THREADS=$(nproc --all)
UVICORN_WORKERS=$(( CPU_THREADS / 4 ))
if [ "$UVICORN_WORKERS" -lt 2 ]; then UVICORN_WORKERS=2; fi
echo "Computed UVICORN_WORKERS=$UVICORN_WORKERS (CPU_THREADS=$CPU_THREADS)"
```

If you want to be more memory conservative, use `/8` instead of `/4` in the formula.

1. Start the service using docker compose

The `docker-compose.yml` in `api/` allows setting `UVICORN_WORKERS`. Start with the computed value:

```bash
# from ~/ai-reception/api on the server
export UVICORN_WORKERS=${UVICORN_WORKERS:-4}
UVICORN_WORKERS=$UVICORN_WORKERS sudo docker compose up --build -d
```

You can also override inline:

```bash
UVICORN_WORKERS=32 sudo docker compose up --build -d
```

If you changed `api/docker-compose.yml` to bind to localhost by default, you can publish to all interfaces with an environment override:

```bash
# Publish backend on all interfaces (not recommended for production without proxy)
BIND_HOST=0.0.0.0 UVICORN_WORKERS=4 sudo docker compose up -d --build
```

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
