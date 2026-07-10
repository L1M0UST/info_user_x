# info_user_x

Collect posts from exact X profile URLs, archive reproducible snapshots locally, translate content through an OpenAI-compatible LLM endpoint, trigger Telegram and DingTalk alerts for China-related matches, and optionally persist dedupe state into PostgreSQL.

## Current Status

This project now supports:

- exact `sources` URLs instead of loose author names
- `Playwright` collection with your real X login
- Linux headless reuse through exported `storage-state.json`
- original text plus translated text
- HTML snapshot plus screenshot plus downloaded images
- folded-post expansion attempts before capture
- Telegram and DingTalk alerting with regex rules
- local archive files designed for later SFTP or FTP based ingestion
- optional PostgreSQL schema initialization and dedupe persistence

## Main Questions Answered

### 1. How Linux without GUI logs in to X

Recommended supported path:

1. On a machine where you can already log in, run:

```powershell
npm run auth:export
```

2. Copy the generated `data/runtime/storage-state.json` to the Linux server.

3. On Linux, import it or point config directly at it:

```bash
npm run auth:import -- /srv/info_user_x/data/runtime/storage-state.json
```

4. Switch config:

```json
"browser": {
  "authStrategy": "storage_state",
  "storageStatePath": "/srv/info_user_x/data/runtime/storage-state.json",
  "headless": true
}
```

There is no fully reliable “username/password headless login” implementation for X that is better than migrating an authenticated storage state, especially when MFA or anti-bot checks appear.

### 2. China-related Telegram and DingTalk alerts

Supported.

Alert flow:

- only newly collected posts enter the alert pipeline
- regex rules match the original text, translated text, links, source label, and post URL
- matched posts send to Telegram and/or DingTalk, depending on `notifyChannels`
- alert dedupe key is `source.id + postId + ruleId + channel`
- `chongqing-priority` is a stronger rule than the general China rule

Fill these yourself in `config.json`:

```json
"alerts": {
  "enabled": true,
  "channels": {
    "telegram": {
      "enabled": true,
      "botTokenEnv": "TELEGRAM_BOT_TOKEN",
      "chatIdEnv": "TELEGRAM_CHAT_ID",
      "messageThreadIdEnv": "TELEGRAM_MESSAGE_THREAD_ID"
    },
    "dingtalk": {
      "enabled": true,
      "webhookEnv": "DINGTALK_WEBHOOK",
      "secretEnv": "DINGTALK_SECRET"
    }
  }
}
```

Alert message content:

- severity, rule, source, post time, post URL, canonical key
- local archive path when available
- original excerpt
- translated excerpt when translation exists
- extracted links and video post URL when present

### 3. Your high-priority sources

Already placed in local config:

- `https://x.com/H4ckmanac`
- `https://x.com/DailyDarkWeb`

### 4. Folded posts and snapshots

Folded or warning-style post states can affect both screenshots and extracted text.

Current mitigation:

- the collector opens the permalink page, not just the timeline card
- before extraction it tries to click common fold-expansion buttons such as `Show more`, `View`, `Yes, view profile`
- the result is recorded in `uiState.hadFoldIndicators` and `uiState.expandActions`

That means later you can tell whether a post needed expansion before snapshotting.

### 5. Local storage for later model parsing and cross-machine transfer

Yes.

Every post now writes:

- `original.txt`
- `translated.zh-CN.txt`
- `translation.json`
- `post.json`
- `ingest-record.json`
- `article.html`
- `page.html`
- `tweet.png`
- `links.json`
- `media/*`

For downstream machine consumption, each run also exports:

- `data/exports/<run_id>/posts.ndjson`
- `data/exports/<run_id>/manifest.json`

This is specifically meant to be easy to move by SFTP first, then consumed later by another machine over FTP.

### 6. Downstream LLM cleaning compatibility

The project now cleans model output for OpenAI-compatible APIs and removes noisy think blocks:

- `<think>...</think>`
- `<thinking>...</thinking>`

That makes it safer for both:

- MiniMax 3 style translation on the collector
- MiniMax 2.7 or Qwen style downstream cleaning on another machine

### 7. PostgreSQL table design

Current schema initialization creates:

- `source_profiles`
- `posts`
- `alerts`
- `runs`
- `ingest_jobs`

Recommended meanings:

- `source_profiles`: tracked source metadata
- `posts`: canonical archived posts and dedupe authority
- `alerts`: alert delivery records
- `runs`: one collection run summary per execution
- `ingest_jobs`: downstream cleaning or ingestion state machine

### 8. PostgreSQL dedupe setup

Dedupe key:

- `canonical_key = source.id + ":" + postId`

This key is the primary key of `posts`.

Initialize schema after filling PG config:

```powershell
npm run db:init
```

## Important Files

- local config: [config.json](/E:/code/py/info_user_x/config.json)
- config template: [config.example.json](/E:/code/py/info_user_x/config.example.json)
- collector entry: [src/cli/collect.js](/E:/code/py/info_user_x/src/cli/collect.js)
- login check: [src/cli/check-login.js](/E:/code/py/info_user_x/src/cli/check-login.js)
- auth export: [src/cli/export-auth.js](/E:/code/py/info_user_x/src/cli/export-auth.js)
- auth import: [src/cli/import-auth.js](/E:/code/py/info_user_x/src/cli/import-auth.js)
- PG init: [src/cli/db-init.js](/E:/code/py/info_user_x/src/cli/db-init.js)
- handoff prepare: [src/cli/prepare-handoff.js](/E:/code/py/info_user_x/src/cli/prepare-handoff.js)
- SFTP upload: [src/cli/sftp-push.js](/E:/code/py/info_user_x/src/cli/sftp-push.js)
- Python downstream: [python_downstream/ftp_pull_and_ingest.py](/E:/code/py/info_user_x/python_downstream/ftp_pull_and_ingest.py)
- ClickHouse schema: [python_downstream/clickhouse_schema.sql](/E:/code/py/info_user_x/python_downstream/clickhouse_schema.sql)
- architecture: [ARCHITECTURE.md](/E:/code/py/info_user_x/ARCHITECTURE.md)

## Content Locations

Per-post archive:

- `data/sources/<source_slug>/posts/<yyyy-mm-dd>/<timestamp_postid>/original.txt`
- `data/sources/<source_slug>/posts/<yyyy-mm-dd>/<timestamp_postid>/translated.zh-CN.txt`
- `data/sources/<source_slug>/posts/<yyyy-mm-dd>/<timestamp_postid>/post.json`
- `data/sources/<source_slug>/posts/<yyyy-mm-dd>/<timestamp_postid>/ingest-record.json`
- `data/sources/<source_slug>/posts/<yyyy-mm-dd>/<timestamp_postid>/tweet.png`

Run-level extraction files for later parsing:

- `data/exports/<run_id>/posts.ndjson`
- `data/exports/<run_id>/manifest.json`

SFTP-ready flat handoff files:

- `data/handoff/outbox/info_user_x_<run_id>.posts.ndjson`
- `data/handoff/outbox/info_user_x_<run_id>.manifest.json`

If you want the exact downstream extraction content, the primary file is:

- `data/exports/<run_id>/posts.ndjson`

Each line is one JSON record containing:

- source metadata
- original text
- translated text
- links
- hashtags
- quoted post URLs
- collected time
- a combined `rawContentForLLM` field for downstream extraction

## Commands

Prepare local config:

```powershell
Copy-Item .\config.example.json .\config.json
```

Check login:

```powershell
npm run check:x
```

Collect posts:

```powershell
npm run collect:x
```

Export auth for Linux:

```powershell
npm run auth:export
```

Import auth bundle:

```powershell
npm run auth:import -- E:\path\to\storage-state.json
```

Initialize PostgreSQL schema:

```powershell
npm run db:init
```

Prepare handoff files:

```powershell
npm run prepare:handoff
```

Push handoff files to your SFTP server:

```powershell
npm run push:sftp
```

Linux daily runner:

```bash
./scripts/run-daily.sh
```

Set MiniMax API key:

```powershell
$env:MINIMAX_API_KEY="your_api_key"
```

Set Telegram and DingTalk env vars:

```powershell
$env:TELEGRAM_BOT_TOKEN="your_bot_token"
$env:TELEGRAM_CHAT_ID="your_chat_id"
$env:TELEGRAM_MESSAGE_THREAD_ID="optional_topic_id"
$env:DINGTALK_WEBHOOK="your_dingtalk_webhook"
$env:DINGTALK_SECRET="your_dingtalk_secret"
$env:SFTP_PASSWORD="your_sftp_password"
$env:SFTP_PRIVATE_KEY_PASSPHRASE="optional_private_key_passphrase"
```

## End-to-End Flow

1. Run `npm run collect:x` on the collector machine.
2. New post content is archived under `data/sources/...` and exported to `data/exports/<run_id>/posts.ndjson`.
3. Run `npm run prepare:handoff` to flatten the latest exports into `data/handoff/outbox/`.
4. Fill `handoff.sftp` in [config.json](/E:/code/py/info_user_x/config.json) and run `npm run push:sftp`.
5. On the isolated Python consumer machine, copy [python_downstream/config.example.json](/E:/code/py/info_user_x/python_downstream/config.example.json) to `config.json` and fill FTP, LLM, and ClickHouse settings.
6. Install Python deps with `pip install -r requirements.txt`.
7. Run `python ftp_pull_and_ingest.py`.
8. The Python script downloads `*.posts.ndjson` from FTP, deletes the remote file after successful local save, cleans each post through the HTTP LLM, checks dedupe by `url`, and inserts into `default.data_breach_events_distributed`.
9. Downloaded source files are archived under `python_downstream/runtime/archive/`, and the local processing state is written to `python_downstream/runtime/state.json`.

## Simple Crontab

Recommended simplest approach:

```bash
cd /home/server/spider/info_user_x
chmod +x scripts/run-daily.sh
crontab -e
```

Then add one line:

```cron
30 8 * * * cd /home/server/spider/info_user_x && /home/server/spider/info_user_x/scripts/run-daily.sh >> /home/server/spider/info_user_x/data/runs/linux-cron.log 2>&1
```

If you want to use the configured cron expression from `config.json`, run:

```bash
./scripts/register-linux-cron.sh
```
