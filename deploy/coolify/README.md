# Crawlee Cloud on Coolify

Use this compose file from Coolify as a Docker Compose application.

## Services

- `api` on port `3000`
- `dashboard` on port `3001`
- `runner` with Docker socket access
- `postgres`, `redis`, `minio`

## Required env vars

- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `REDIS_PASSWORD`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `API_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

## Coolify notes

- `CORS_ORIGINS` and `NEXT_PUBLIC_API_URL` use Coolify-generated service URLs.
- The runner requires `/var/run/docker.sock` to be mounted by the host.
