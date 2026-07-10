import ftplib
import json
import logging
import os
import re
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import clickhouse_connect
import requests


def utc_now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def ensure_dir(path_str):
    Path(path_str).mkdir(parents=True, exist_ok=True)


def load_config():
    config_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("config.json")
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")
    with config_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_state(state_path):
    if not os.path.exists(state_path):
        return {"version": 1, "processed_files": {}, "processed_urls": {}}
    with open(state_path, "r", encoding="utf-8") as handle:
        state = json.load(handle)
    state.setdefault("version", 1)
    state.setdefault("processed_files", {})
    state.setdefault("processed_urls", {})
    return state


def save_state(state_path, state):
    ensure_dir(str(Path(state_path).parent))
    with open(state_path, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)


def setup_logging(log_path):
    ensure_dir(str(Path(log_path).parent))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(log_path, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def strip_think_tags(text):
    return re.sub(r"<think>[\s\S]*?</think>|<thinking>[\s\S]*?</thinking>", "", text or "", flags=re.I).strip()


def extract_json_object(text):
    cleaned = strip_think_tags(text.strip())
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned, re.I)
    source = fenced.group(1).strip() if fenced else cleaned
    start = source.find("{")
    if start == -1:
        raise ValueError(f"No JSON object found: {cleaned}")

    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(source)):
        char = source[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise ValueError(f"Unclosed JSON object: {cleaned}")


def normalize_text(value):
    text = str(value or "").replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def ensure_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        if not value.strip():
            return []
        return [item.strip() for item in re.split(r"[,\n;]+", value) if item.strip()]
    return [str(value).strip()]


def ensure_uint8(value):
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return 1 if int(value) else 0
    if isinstance(value, str):
        return 1 if value.strip().lower() in {"1", "true", "yes", "y"} else 0
    return 0


def parse_iso_datetime(value):
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_date(value):
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text[:10]).date()
    except ValueError:
        return None


def get_llm_api_key(config):
    if config["llm"].get("apiKey"):
        return config["llm"]["apiKey"]
    env_name = config["llm"].get("apiKeyEnv")
    return os.getenv(env_name or "", "")


def extract_message_content(response_json):
    content = response_json.get("choices", [{}])[0].get("message", {}).get("content")
    if isinstance(content, str):
        return strip_think_tags(content)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(item.get("text", ""))
        return strip_think_tags("".join(parts))
    return ""


def call_llm_json(config, task_name, payload):
    if not config["llm"].get("enabled", True):
        raise RuntimeError("LLM is disabled in config")
    api_key = get_llm_api_key(config)
    if not api_key:
        raise RuntimeError("Missing LLM API key")

    url = config["llm"]["baseUrl"].rstrip("/") + "/chat/completions"
    body = {
        "model": config["llm"]["model"],
        "temperature": config["llm"].get("temperature", 0.1),
        "messages": [
            {
                "role": "system",
                "content": "You are a strict JSON generator. Output only valid JSON. No markdown fences. No extra text."
            },
            {
                "role": "user",
                "content": json.dumps({
                    "task": task_name,
                    "output_schema": {
                        "title": "string",
                        "company_name": "string",
                        "country": "string",
                        "region": "string",
                        "industry_sector": "string",
                        "breach_date": "YYYY-MM-DD or null",
                        "records_count": "integer or null",
                        "data_types": ["string"],
                        "attack_vector": "string",
                        "cve_ids": ["string"],
                        "severity": "string",
                        "ransom_involved": "0 or 1",
                        "tags": ["string"],
                        "attacker_name": "string",
                        "attacker_type": "string",
                        "attacker_aliases": ["string"],
                        "attacker_country": "string",
                        "attacker_region": "string",
                        "attacker_ips": ["string"],
                        "attacker_domains": ["string"],
                        "attacker_urls": ["string"]
                    },
                    "payload": payload
                }, ensure_ascii=False)
            }
        ]
    }

    last_error = None
    for attempt in range(config["llm"].get("retries", 2) + 1):
        try:
            response = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=config["llm"].get("timeoutSeconds", 60),
            )
            response.raise_for_status()
            payload_text = extract_message_content(response.json())
            return json.loads(extract_json_object(payload_text))
        except Exception as error:
            last_error = error
            time.sleep(0.5 * (attempt + 1))
    raise last_error


def build_llm_payload(record):
    post = record.get("post", {})
    source = record.get("source", {})
    return {
        "url": post.get("postUrl", ""),
        "source": source.get("label", ""),
        "site_id": source.get("id", ""),
        "published_at": post.get("createdAt"),
        "crawled_at": record.get("collectedAt"),
        "original_text": post.get("originalText", ""),
        "translated_text": post.get("translatedText", ""),
        "raw_content_for_llm": post.get("rawContentForLLM", ""),
        "hashtags": post.get("hashtags", []),
        "links": [item.get("url", "") for item in post.get("links", [])],
        "quoted_post_urls": post.get("quotedPostUrls", []),
        "source_profile_url": source.get("url", ""),
    }


def build_clickhouse_row(record, cleaned):
    post = record.get("post", {})
    source = record.get("source", {})
    crawled_at = parse_iso_datetime(record.get("collectedAt")) or datetime.now(timezone.utc)
    published_at = parse_iso_datetime(post.get("createdAt"))
    url = post.get("postUrl") or post.get("canonicalUrl") or ""

    if not url:
        raise ValueError("Missing post URL")

    raw_content = normalize_text(
        "\n\n".join(
            part for part in [
                post.get("originalText", ""),
                post.get("translatedText", ""),
            ] if part
        )
    )

    records_count = cleaned.get("records_count")
    if records_count in ("", None):
        records_count = None
    else:
        records_count = int(records_count)

    return {
        "url": url,
        "source": source.get("label", ""),
        "site_id": source.get("id", ""),
        "published_at": published_at,
        "crawled_at": crawled_at,
        "breach_date": parse_date(cleaned.get("breach_date")),
        "title": normalize_text(cleaned.get("title", "")),
        "company_name": normalize_text(cleaned.get("company_name", "")),
        "country": normalize_text(cleaned.get("country", "")),
        "region": normalize_text(cleaned.get("region", "")),
        "industry_sector": normalize_text(cleaned.get("industry_sector", "")),
        "records_count": records_count,
        "data_types": ensure_list(cleaned.get("data_types")),
        "attack_vector": normalize_text(cleaned.get("attack_vector", "")),
        "cve_ids": ensure_list(cleaned.get("cve_ids")),
        "severity": normalize_text(cleaned.get("severity", "")),
        "ransom_involved": ensure_uint8(cleaned.get("ransom_involved")),
        "raw_content": raw_content,
        "tags": ensure_list(cleaned.get("tags")) or ensure_list(post.get("hashtags")),
        "attacker_name": normalize_text(cleaned.get("attacker_name", "")),
        "attacker_type": normalize_text(cleaned.get("attacker_type", "")),
        "attacker_aliases": ensure_list(cleaned.get("attacker_aliases")),
        "attacker_country": normalize_text(cleaned.get("attacker_country", "")),
        "attacker_region": normalize_text(cleaned.get("attacker_region", "")),
        "attacker_ips": ensure_list(cleaned.get("attacker_ips")),
        "attacker_domains": ensure_list(cleaned.get("attacker_domains")),
        "attacker_urls": ensure_list(cleaned.get("attacker_urls")),
    }


def create_clickhouse_client(config):
    return clickhouse_connect.get_client(
        host=config["clickhouse"]["host"],
        port=config["clickhouse"]["port"],
        username=config["clickhouse"]["username"],
        password=config["clickhouse"]["password"],
        database=config["clickhouse"]["database"],
        secure=config["clickhouse"].get("secure", False),
    )


def row_exists(client, table_name, url):
    result = client.query(
        f"SELECT 1 FROM {table_name} WHERE url = {{url:String}} LIMIT 1",
        parameters={"url": url},
    )
    return len(result.result_rows) > 0


def insert_row(client, table_name, row):
    column_names = list(row.keys())
    client.insert(
        table=table_name,
        data=[[row[name] for name in column_names]],
        column_names=column_names,
    )


def process_ndjson_file(file_path, config, state, client):
    processed = 0
    inserted = 0
    skipped = 0
    table_name = f'{config["clickhouse"]["database"]}.{config["clickhouse"]["table"]}'

    with open(file_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue

            processed += 1
            record = json.loads(line)
            post = record.get("post", {})
            url = post.get("postUrl") or post.get("canonicalUrl") or ""
            if not url:
                skipped += 1
                continue

            if state["processed_urls"].get(url):
                skipped += 1
                continue

            if row_exists(client, table_name, url):
                state["processed_urls"][url] = {"status": "exists", "checkedAt": utc_now_iso()}
                skipped += 1
                continue

            cleaned = call_llm_json(config, "clean_data_breach_event", build_llm_payload(record))
            row = build_clickhouse_row(record, cleaned)
            insert_row(client, table_name, row)

            state["processed_urls"][url] = {
                "status": "inserted",
                "insertedAt": utc_now_iso(),
            }
            inserted += 1

    return {
        "processed": processed,
        "inserted": inserted,
        "skipped": skipped,
    }


def pull_files_from_ftp(config):
    ftp_config = config["ftp"]
    downloads_dir = config["runtime"]["downloadsDir"]
    ensure_dir(downloads_dir)

    ftp = ftplib.FTP()
    ftp.connect(ftp_config["host"], ftp_config.get("port", 21), timeout=ftp_config.get("timeoutSeconds", 60))
    ftp.login(ftp_config["username"], ftp_config["password"])
    ftp.set_pasv(ftp_config.get("passive", True))
    ftp.cwd(ftp_config["remoteDir"])

    names = ftp.nlst()
    target_names = sorted([name for name in names if name.endswith(".posts.ndjson")])
    downloaded = []

    try:
        for name in target_names:
            local_path = os.path.join(downloads_dir, name)
            with open(local_path, "wb") as handle:
                ftp.retrbinary(f"RETR {name}", handle.write)
            ftp.delete(name)

            manifest_name = name.replace(".posts.ndjson", ".manifest.json")
            if manifest_name in names:
                manifest_local_path = os.path.join(downloads_dir, manifest_name)
                with open(manifest_local_path, "wb") as handle:
                    ftp.retrbinary(f"RETR {manifest_name}", handle.write)
                ftp.delete(manifest_name)

            downloaded.append(local_path)
    finally:
        ftp.quit()

    return downloaded


def archive_file(file_path, archive_dir):
    ensure_dir(archive_dir)
    destination = os.path.join(archive_dir, os.path.basename(file_path))
    shutil.move(file_path, destination)
    return destination


def archive_related_manifest(file_path, archive_dir):
    manifest_path = file_path.replace(".posts.ndjson", ".manifest.json")
    if not os.path.exists(manifest_path):
        return None
    return archive_file(manifest_path, archive_dir)


def main():
    config = load_config()
    setup_logging(config["runtime"]["logPath"])
    ensure_dir(config["runtime"]["baseDir"])
    ensure_dir(config["runtime"]["downloadsDir"])
    ensure_dir(config["runtime"]["archiveDir"])

    state = load_state(config["runtime"]["statePath"])
    downloaded_files = pull_files_from_ftp(config)
    if not downloaded_files:
        logging.info("No new FTP files found.")
        return

    client = create_clickhouse_client(config)
    try:
        for file_path in downloaded_files:
            file_name = os.path.basename(file_path)
            if state["processed_files"].get(file_name):
                logging.info("Skip already processed file: %s", file_name)
                continue

            stats = process_ndjson_file(file_path, config, state, client)
            archived_path = archive_file(file_path, config["runtime"]["archiveDir"])
            archived_manifest_path = archive_related_manifest(file_path, config["runtime"]["archiveDir"])
            state["processed_files"][file_name] = {
                "processedAt": utc_now_iso(),
                "archivedPath": archived_path,
                "archivedManifestPath": archived_manifest_path,
                **stats,
            }
            save_state(config["runtime"]["statePath"], state)
            logging.info("Processed %s: %s", file_name, stats)
    finally:
        client.close()


if __name__ == "__main__":
    main()
