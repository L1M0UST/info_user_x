#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

npm run collect:x
npm run prepare:handoff

SFTP_ENABLED="$(node -e "const fs=require('fs'); const config=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(config.handoff?.sftp?.enabled ? 'true' : 'false');" "$PROJECT_ROOT/config.json")"
if [ "$SFTP_ENABLED" = "true" ]; then
  npm run push:sftp
fi
