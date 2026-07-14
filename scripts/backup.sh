#!/bin/bash
# Daily backup script — run via host cron at 03:00 WIB
# Copies tomo.db → data/backups/tomo_YYYYMMDDHHMMSS.db, retains 14 days

set -euo pipefail
cd "$(dirname "$0")/.."
DATA_DIR="$(pwd)/data"
BACKUP_DIR="$DATA_DIR/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d%H%M%S)
cp "$DATA_DIR/tomo.db" "$BACKUP_DIR/tomo_$TIMESTAMP.db"
echo "backup: created $BACKUP_DIR/tomo_$TIMESTAMP.db"

# Retain 14 days
find "$BACKUP_DIR" -name 'tomo_*.db' -mtime +14 -delete 2>/dev/null || true
echo "backup: retention done"
