#!/bin/sh
set -eu

read_secret() {
  variable="$1"
  eval "file=\${${variable}_FILE:-}"
  if [ -n "${file:-}" ]; then
    [ -r "$file" ] || { echo "$variable secret file is not readable" >&2; exit 1; }
    value=$(cat "$file")
    export "$variable=$value"
    unset "${variable}_FILE"
  fi
}

for variable in CREDENTIAL_MASTER_KEY BOOTSTRAP_PASSWORD ENROLLMENT_TOKEN DATABASE_PASSWORD; do
  read_secret "$variable"
done

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_PASSWORD:-}" ]; then
  encoded=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DATABASE_PASSWORD")
  export DATABASE_URL="postgresql://${DATABASE_USER:-botroost}:${encoded}@${DATABASE_HOST:-postgres}:${DATABASE_PORT:-5432}/${DATABASE_NAME:-botroost}"
fi

if [ "$#" -gt 0 ]; then exec "$@"; fi
case "${BOTROOST_PROCESS:-}" in
  api) exec node apps/api/dist/server.js ;;
  worker) exec node apps/worker/dist/cli.js ;;
  agent) exec node apps/agent/dist/cli.js ;;
  migrate) exec node apps/api/dist/migrate.js ;;
  bootstrap)
    [ -n "${BOOTSTRAP_EMAIL:-}" ] && [ -n "${BOOTSTRAP_WORKSPACE:-}" ] || { echo "BOOTSTRAP_EMAIL and BOOTSTRAP_WORKSPACE are required" >&2; exit 1; }
    exec node apps/api/dist/cli.js bootstrap --email "$BOOTSTRAP_EMAIL" --workspace "$BOOTSTRAP_WORKSPACE" <<EOF
${BOOTSTRAP_PASSWORD:-}
EOF
    ;;
  *) echo "unknown BOTROOST_PROCESS: ${BOTROOST_PROCESS:-unset}" >&2; exit 64 ;;
esac
