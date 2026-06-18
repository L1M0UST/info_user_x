# Architecture Summary

## Current Engine

- Browser engine: `Playwright`
- Login mode on Windows: reuse your real Edge profile
- Linux migration path: export `storage-state.json`, then switch config to `storage_state`
- Proxy: `http://127.0.0.1:7890`

## How Posts Are Identified

The collector opens an exact source URL from `config.json`, reads the visible timeline, extracts tweet permalinks, then opens each tweet permalink page to capture a reproducible snapshot.

For each post we collect:

- canonical post URL
- post ID
- author handle
- UTC created time
- original text
- extracted links
- hashtags and mentions
- image URLs
- whether video is present
- article HTML snapshot
- page HTML snapshot
- screenshot

## Reproduction Strategy

Each stored post keeps enough material to reconstruct the post later:

- `original.txt`
- `translated.zh-CN.txt`
- `translation.json`
- `post.json`
- `article.html`
- `page.html`
- `tweet.png`
- `media/*`
- `links.json`

Even if X later changes layout, you still retain:

- the original text
- the translated text
- a screenshot
- the HTML snapshot
- the resource manifest
- the canonical URL

## Deduplication

Deduplication key:

- `source.id + postId`

Optional PostgreSQL dedupe:

- same canonical key is also stored in PostgreSQL when enabled

The collector therefore avoids duplicate ingestion across repeated runs, while still keeping the local archive.

## Translation

Translation uses an OpenAI-compatible endpoint and expects `MiniMax-M3` by default.

The translation output is cleaned through:

- strict JSON prompting
- JSON extraction from noisy model output
- schema validation before writing files

## Practical Detection Note

There is no zero-detection automation stack.

Current choice:

- `Playwright + real Edge profile`

Reason:

- closer to normal browser behavior than stock Selenium setups
- easier profile reuse than Selenium
- better maintainability and Linux portability than DrissionPage

This is an engineering judgment, not a guarantee of lower detection in every environment.
