#!/bin/sh
# One-time setup on a fresh Ubuntu 22.04/24.04 server (run as root).
set -e
apt-get update
apt-get install -y ca-certificates curl ufw
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable
cd "$(dirname "$0")/.."
mkdir -p data backups && chown -R 1000:1000 data
chmod +x deploy/backup.sh
( crontab -l 2>/dev/null | grep -v deploy/backup.sh; echo "30 2 * * * $(pwd)/deploy/backup.sh >> $(pwd)/backups/backup.log 2>&1" ) | crontab -
echo "Server ready. Next: edit .env, then run:  docker compose up -d --build"
