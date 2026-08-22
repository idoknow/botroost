# Container deployment

## Prerequisites

Docker Engine with Compose v2, and an existing reverse-proxy network (default `botroost-shared`). Only `web` joins that external network; PostgreSQL, API, worker, migrate, bootstrap, and agent remain on the internal backend network.

## Secrets and first bootstrap

```sh
cd deploy
cp .env.example .env
mkdir -m 700 secrets
docker network create botroost-shared # once; skip if the proxy already owns it
openssl rand -base64 36 > secrets/postgres_password
openssl rand -base64 32 > secrets/credential_master_key
# Enter a unique 12+ character owner password; it is never put in Compose or .env.
umask 077; printf '%s' 'replace-interactively' > secrets/bootstrap_password
chmod 600 secrets/*
```

Set `BOTROOST_PUBLIC_ORIGIN` to the exact browser origin (scheme and host, no path). Add the `deploy/Caddyfile` snippet to Caddy. Build and start the empty database; migration is a one-shot dependency and must succeed before API/worker:

Set `RESEND_API_KEY` and `ALERT_EMAIL_FROM` in `deploy/.env`. These worker-only environment variables control email delivery and sender identity; the web console stores only notification targets and per-endpoint subscriptions.

```sh
docker compose build
docker compose up -d postgres api worker web
docker compose --profile bootstrap run --rm bootstrap
```

Bootstrap is intentionally profile-gated and fails once any user exists. Remove `secrets/bootstrap_password` after success. Never retain a shared/test owner password.

## Agent enrollment

As an owner/admin, generate a one-use token in the Nodes page. Put it in `secrets/enrollment_token` with mode 0600, then run:

```sh
docker compose --profile bootstrap-agent up -d agent
```

The agent exchanges it once and persists only its node credential in `agent-state`. Remove `secrets/enrollment_token` after enrollment. Endpoint creation requires selecting an enrolled node.

## Verification and lifecycle

```sh
docker compose ps
docker compose exec api node -e "fetch('http://127.0.0.1:3000/ready').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
curl -fsS https://console.example.com/health
docker compose logs migrate api worker web
```

Stop without deleting data using `docker compose down`. Back up the `postgres-data` volume before upgrades. Apply upgrades with `docker compose build --pull && docker compose up -d`; the advisory-locked ledger validates checksums and applies pending migrations once. Do not use `down -v` unless permanent deletion is intended.

`DATABASE_PASSWORD_FILE`, `CREDENTIAL_MASTER_KEY_FILE`, `BOOTSTRAP_PASSWORD_FILE`, and `ENROLLMENT_TOKEN_FILE` are consumed by the entrypoint. The Compose defaults mount those file-backed secrets. Email delivery uses the worker-only `RESEND_API_KEY` and `ALERT_EMAIL_FROM` environment variables configured in `deploy/.env`; neither value is editable or returned by the web/API settings surface.
