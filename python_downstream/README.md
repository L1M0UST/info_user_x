# Python Downstream

This folder is for the offline or isolated consumer machine.

It does three jobs:

1. pull collector handoff files from an FTP server
2. delete remote files after a successful local download
3. call an OpenAI-compatible LLM over HTTP, clean the response, and insert structured rows into ClickHouse

Main script:

- `ftp_pull_and_ingest.py`

Config template:

- `config.example.json`

Schema file:

- `clickhouse_schema.sql`
