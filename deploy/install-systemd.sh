#!/usr/bin/env bash
set -euo pipefail
# Run from a built, version-pinned checkout; never downloads an unpinned release.
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${EUID} -ne 0 ]]; then printf 'Run with sudo.\n' >&2; exit 1; fi
for cmd in node docker systemctl install cp; do command -v "$cmd" >/dev/null || { printf 'Missing dependency: %s\n' "$cmd" >&2; exit 1; }; done
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
[[ -f "$ROOT/apps/agent/dist/cli.js" && -d "$ROOT/node_modules" ]] || { printf 'Run bun install --frozen-lockfile && bun run build first.\n' >&2; exit 1; }
getent group docker >/dev/null || { printf 'Docker group missing.\n' >&2; exit 1; }
id botroost >/dev/null 2>&1 || useradd --system --home-dir /var/lib/botroost --shell /usr/sbin/nologin botroost
usermod -aG docker botroost
install -d -m 700 /etc/botroost
install -d -o botroost -g botroost -m 700 /var/lib/botroost
if systemctl is-active --quiet botroost-agent; then systemctl stop botroost-agent; fi
install -d -m 755 /opt/botroost
if [[ "$ROOT" != /opt/botroost ]]; then
  for item in apps packages node_modules package.json; do cp -a "$ROOT/$item" /opt/botroost/; done
fi
if [[ ! -f /etc/botroost/agent.env ]]; then install -m 600 "$ROOT/deploy/agent.env.example" /etc/botroost/agent.env; fi
install -m 644 "$ROOT/deploy/botroost-agent.service" /etc/systemd/system/botroost-agent.service
systemctl daemon-reload
printf 'Installed without starting. Edit /etc/botroost/agent.env, then run:\n  sudo systemctl enable --now botroost-agent\n'
