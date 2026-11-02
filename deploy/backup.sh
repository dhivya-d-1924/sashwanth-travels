#!/bin/sh
# Daily backup of bookings, accounts, photos and the encryption key. Keeps 14 days.
# Install: crontab -e  →  30 2 * * * /opt/sashwanth-travels/deploy/backup.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p backups
STAMP=$(date +%Y-%m-%d_%H%M)
tar -czf "backups/data_$STAMP.tar.gz" data .env
find backups -name 'data_*.tar.gz' -mtime +14 -delete
echo "Backup saved: backups/data_$STAMP.tar.gz"
