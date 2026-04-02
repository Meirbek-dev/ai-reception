# AI-Reception

## Shadcn

Add components using the latest version of [Shadcn](https://ui.shadcn.com/).

```bash
pnpx shadcn@latest add button
```

## Deployment (concise)

These steps assume you have SSH access to your Ubuntu server (user@192.168.12.35), Docker and docker-compose installed, and DNS for the domain pointing to the server.

1. Build the frontend locally (or on the server). This places the static assets under `api/build/web` which the Python app will serve.

```bash
# from repository root
pnpm --prefix web install --frozen-lockfile --no-private
pnpm --prefix web run build
```

2. On the server: copy the repo, then start the service with docker-compose (this will build images and publish :5040 on the host).

```bash
# on server (from repo root)
docker compose up -d --build
```

3. NGINX: use a simple reverse-proxy pointing to localhost:5040. Example `nginx.conf` (already in repo) expects certs at `/etc/nginx/ssl/ai-reception.tou.edu.kz.{crt|key}` and proxies to `http://127.0.0.1:5040`.

Notes and best-practices:

- Keep uploads persistent: the compose file mounts `./api/uploads` on the host to `/app/uploads` in the container.
- Healthcheck uses `/health` (FastAPI endpoint). The compose healthcheck and Dockerfile production HEALTHCHECK are aligned to `/health`.
- If you want nginx to serve static assets directly, copy `api/build/web` onto the host and point nginx `root` to that directory; otherwise the FastAPI app will serve static files for the web UI.
