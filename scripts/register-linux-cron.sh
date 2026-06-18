#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_PATH="$PROJECT_ROOT/config.json"

CRON_EXPR="$(node -e "const fs=require('fs'); const config=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(config.schedule.linuxCron || '30 8 * * *');" "$CONFIG_PATH")"
COMMAND="cd \"$PROJECT_ROOT\" && npm run collect:x >> \"$PROJECT_ROOT/data/runs/linux-cron.log\" 2>&1"

(crontab -l 2>/dev/null; echo "$CRON_EXPR $COMMAND") | crontab -
