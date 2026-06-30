# info_user_x

Collect posts from exact X profile URLs, archive reproducible snapshots locally, translate content through an OpenAI-compatible LLM endpoint, trigger DingTalk alerts for China-related matches, and optionally persist dedupe state into PostgreSQL.

## Current Status

This project now supports:

- exact `sources` URLs instead of loose author names
- `Playwright` collection with your real X login
- Linux headless reuse through exported `storage-state.json`
- original text plus translated text
- HTML snapshot plus screenshot plus downloaded images
- folded-post expansion attempts before capture
- DingTalk alerting with regex rules
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

### 2. China-related DingTalk alerts

Supported.

Alert flow:

- regex rules match the original text, translated text, links, source label, and post URL
- matched posts send a DingTalk markdown message
- alert dedupe key is `source.id + postId + ruleId`

Fill these yourself in `config.json`:

```json
"alerts": {
  "enabled": true,
  "dingtalk": {
    "webhook": "",
    "secret": ""
  }
}
```

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
- architecture: [ARCHITECTURE.md](/E:/code/py/info_user_x/ARCHITECTURE.md)

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

Set MiniMax API key:

```powershell
$env:MINIMAX_API_KEY="your_api_key"
```
