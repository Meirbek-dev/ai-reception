Deployment guide for ai-reception

This document explains how to build and deploy the project to an Ubuntu server (accessible via SSH at user@192.168.12.35) and serve it on https://ai-reception.tou.edu.kz using Docker + docker-compose and nginx.

Assumptions

- You have Docker and docker-compose installed on the server (or can install them).
- You control DNS for ai-reception.tou.edu.kz and it points to the server's public IP.
- Ports 80 and 443 are open.
- You have SSH access: ssh user@192.168.12.35

Overview

1. Build the frontend into `api/build/web` locally.
2. Build the Docker image and push to the server (or build on server).
3. Use `docker-compose` on the server to run the `ai-reception` service.
4. Configure nginx on the server to reverse-proxy to the backend container (5040) and enable TLS via certbot.

Local build (developer machine)

# Install dependencies and build frontend

pnpm install
pnpm run build:frontend

# Optional: run TypeScript check

pnpm run build:all

This will emit files to `api/build/web` which the backend serves as static files.

Prepare server

# Copy project to server or push to git + pull

# Example using scp (from project root):

scp -r . user@192.168.12.35:~/ai-reception

SSH into server

ssh user@192.168.12.35

# On server: change to project folder

cd ~/ai-reception/api

# Build and run with docker-compose

sudo docker compose up --build -d

This will build the image using the `api/Dockerfile` and run the container exposing port 5040. The compose file maps volume `./uploads` so uploaded files persist.

nginx and TLS (on host)

You can either use the provided `api/nginx.conf` as a starting point or use the host nginx to terminate TLS and proxy to the container.

Example host nginx site (replace paths):

/etc/nginx/sites-available/ai-reception

# server block using the provided nginx.conf in the repo

Enable and test nginx configuration, then obtain certificates with certbot:

sudo ln -s /etc/nginx/sites-available/ai-reception /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Obtain certificate

sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ai-reception.tou.edu.kz

After certbot succeeds, your site will be served over HTTPS and proxied to the container on port 5040.

Notes and troubleshooting

- If you build images locally and push to a registry, ensure the server can pull them. Alternatively, build on the server with `docker compose build`.
- If using a firewall, open ports 80 and 443 and ensure the container port 5040 is reachable by nginx on the host (localhost:5040).
- Logs: use `sudo docker compose logs -f` and `sudo journalctl -u nginx -f` for debugging.

If you want, I can also:

- Add a small `Makefile` or `scripts/` to automate build+deploy.
- Add a `Dockerfile` tweak so the container runs as non-root and includes the build step in the image.

Done.
