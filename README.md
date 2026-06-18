# info_user_x

Use a logged-in X browser session to collect posts from exact profile URLs, keep reproducible local snapshots, translate the text with an OpenAI-compatible API, and optionally mirror dedupe state into PostgreSQL.

## What Changed

This project now uses:

- exact source URLs instead of only `authors`
- Playwright as the browser engine
- original text plus translated text
- HTML snapshots plus screenshots
- media downloads for images
- strict local dedupe
- optional PostgreSQL persistence
- proxy support for local `7890`
- Linux migration support through exported `storage-state.json`

## Current Design Answers

### 1. How posts are viewed and identified

The collector uses `Playwright` with your logged-in browser session.

It works in two stages:

- open the exact source timeline URL from `config.json`
- collect tweet permalinks from the timeline
- open each permalink page to extract the full post snapshot

Resources are identified from the tweet DOM:

- text from the tweet text block
- links from anchors inside the tweet article
- images from `pbs.twimg.com/media`
- video presence from the video player container
- canonical URL and timestamp from the tweet page itself

### 2. How a collected post is reproduced

Each post folder stores enough material to reproduce the post later:

- `original.txt`
- `translated.zh-CN.txt`
- `translation.json`
- `post.json`
- `article.html`
- `page.html`
- `tweet.png`
- `media/`
- `links.json`

### 3. Links, images, and language

- links are saved in `links.json`
- image URLs are downloaded into `media/`
- the original text is always kept in `original.txt`
- the translated text is written to `translated.zh-CN.txt`

Translation uses an OpenAI-compatible endpoint and defaults to:

- model: `MiniMax-M3`
- base URL: `https://api.minimax.io/v1`
- API key source: environment variable `MINIMAX_API_KEY`

### 4. Snapshot support

Yes.

Each post has:

- screenshot snapshot: `tweet.png`
- article HTML snapshot: `article.html`
- page HTML snapshot: `page.html`

### 5. Why Playwright

Current engine:

- `Playwright`

Practical judgment:

- better than stock Selenium for real-profile reuse
- easier to keep stable than DrissionPage in a cross-platform project
- still not undetectable

There is no automation stack with guaranteed lowest detection. This project currently prefers `Playwright + real browser profile`.

### 6. Exact URL source list

Done.

The project now uses `sources` with exact URLs:

```json
{
  "id": "dailydarkweb",
  "label": "DailyDarkWeb",
  "enabled": true,
  "url": "https://x.com/DailyDarkWeb",
  "maxPosts": 5
}
```

### 7. Storage for later analysis

Storage is optimized for both replay and analysis:

- local text files for quick reading
- JSON metadata for parsing
- screenshots and HTML for replay
- downloaded images for media preservation

### 8. Dedupe

Dedupe key:

- `source.id + postId`

The same post is only archived once.

### 9. Can it monitor bot accounts

Yes, if:

- the target page is reachable by your logged-in session
- the posts are visible to that account

### 10. MiniMax integration

Done in OpenAI-compatible form.

Set your API key yourself:

```powershell
$env:MINIMAX_API_KEY="your_api_key"
```

### 11. LLM output cleaning

Done.

The translation pipeline:

- forces JSON-only output
- extracts JSON if the model adds noise
- validates required fields before storing

### 12. PostgreSQL

Optional support is included.

Current defaults:

- database: `postgres`
- user: `taishi`
- schema: `info_user_x`

Enable it in `config.json`:

```json
"database": {
  "enabled": true,
  "optional": true,
  "host": "127.0.0.1",
  "port": 5432,
  "database": "postgres",
  "user": "taishi",
  "passwordEnv": "PGPASSWORD",
  "schema": "info_user_x"
}
```

### 13. GitHub target

Target repo:

- [L1M0UST/info_user_x](https://github.com/L1M0UST/info_user_x)

This local directory was not originally a Git repository, so it still needs `git init`, remote binding, and push.

### 14. Proxy

Proxy is built in:

- `http://127.0.0.1:7890`

It is used for:

- browser launch
- media downloads
- LLM HTTP requests

### 15. Linux server path

For Linux later:

1. Run once on Windows and export `storage-state.json`
2. Copy the project and `data/runtime/storage-state.json` to Linux
3. Change config:

```json
"browser": {
  "authStrategy": "storage_state",
  "storageStatePath": "/srv/info_user_x/data/runtime/storage-state.json",
  "executablePath": "/usr/bin/google-chrome",
  "headless": true
}
```

## Key Files

- local config: [config.json](/E:/code/py/info_user_x/config.json)
- config template: [config.example.json](/E:/code/py/info_user_x/config.example.json)
- config: [config.json](/E:/code/py/info_user_x/config.json)
- collection entry: [src/cli/collect.js](/E:/code/py/info_user_x/src/cli/collect.js)
- login check: [src/cli/check-login.js](/E:/code/py/info_user_x/src/cli/check-login.js)
- architecture summary: [ARCHITECTURE.md](/E:/code/py/info_user_x/ARCHITECTURE.md)

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

Set MiniMax API key:

```powershell
$env:MINIMAX_API_KEY="your_api_key"
```
