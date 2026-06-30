# Architecture Summary

## Browser and Auth

- engine: `Playwright`
- Windows auth: real Edge profile reuse
- Linux auth: `storage_state`
- auth migration commands:
  - `npm run auth:export`
  - `npm run auth:import -- <storage-state.json>`

## Collection Flow

For each configured source URL:

1. open the exact source timeline
2. collect visible post permalinks
3. open each permalink page
4. try to expand folded content
5. extract text, links, media, timestamps, and snapshots
6. translate text
7. store local archive
8. send alerts if rules match
9. persist dedupe state locally and optionally in PostgreSQL

## Snapshot and Replay

Each post archive contains:

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

This is enough for:

- manual review
- later model-based parsing
- SFTP handoff
- FTP-side downstream consumers

## Folded Content Handling

Folded or warning-gated content is handled by opening the permalink page and attempting expansion before extraction.

Recorded fields:

- `uiState.hadFoldIndicators`
- `uiState.expandActions`

## Deduplication

Local dedupe:

- `source.id + ":" + postId`

PostgreSQL dedupe:

- same canonical key as `posts.canonical_key`

Alert dedupe:

- `source.id + ":" + postId + ":" + ruleId`

## Alerting

Alert target:

- DingTalk custom robot webhook

Alert match inputs:

- original text
- translated text
- source URL
- post URL
- extracted links

## Database Design

Tables:

- `source_profiles`
- `posts`
- `alerts`
- `runs`
- `ingest_jobs`

Recommended use:

- `posts`: canonical archive and primary dedupe source
- `ingest_jobs`: downstream cleaning and warehouse status tracking
- `alerts`: operational audit for message delivery

## LLM Compatibility

Collector-side translation:

- OpenAI-compatible endpoint
- default model: `MiniMax-M3`

Output cleanup:

- strict JSON prompting
- JSON extraction from noisy responses
- removal of `<think>` and `<thinking>` blocks

That keeps the interface practical for both MiniMax and Qwen style OpenAI-compatible services.
