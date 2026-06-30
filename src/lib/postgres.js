const { Client } = require('pg');

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

async function initSchema(client, schemaName) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.source_profiles (
      source_id TEXT PRIMARY KEY,
      source_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      author_handle TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.posts (
      canonical_key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      source_url TEXT NOT NULL,
      author_handle TEXT,
      post_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      created_at TIMESTAMPTZ,
      first_collected_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      content_hash TEXT NOT NULL,
      raw_text TEXT,
      translated_text TEXT,
      detected_language TEXT,
      target_language TEXT,
      has_video BOOLEAN NOT NULL DEFAULT FALSE,
      local_dir TEXT NOT NULL,
      screenshot_path TEXT,
      article_snapshot_path TEXT,
      page_snapshot_path TEXT,
      payload JSONB NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.alerts (
      alert_key TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      post_url TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.runs (
      run_id TEXT PRIMARY KEY,
      collected_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schemaName}.ingest_jobs (
      canonical_key TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      cleaning_provider TEXT,
      cleaning_model TEXT,
      cleaning_attempts INTEGER NOT NULL DEFAULT 0,
      cleaned_at TIMESTAMPTZ,
      downstream_payload JSONB,
      error_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function createStore(client, schemaName) {
  return {
    async hasPost(canonicalKey) {
      const result = await client.query(
        `SELECT 1 FROM ${schemaName}.posts WHERE canonical_key = $1 LIMIT 1`,
        [canonicalKey]
      );
      return result.rowCount > 0;
    },
    async saveSourceProfile(profile) {
      await client.query(`
        INSERT INTO ${schemaName}.source_profiles (
          source_id, source_label, source_url, author_handle, enabled, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (source_id) DO UPDATE SET
          source_label = EXCLUDED.source_label,
          source_url = EXCLUDED.source_url,
          author_handle = EXCLUDED.author_handle,
          enabled = EXCLUDED.enabled,
          updated_at = NOW()
      `, [
        profile.sourceId,
        profile.sourceLabel,
        profile.sourceUrl,
        profile.authorHandle,
        profile.enabled,
      ]);
    },
    async savePost(record) {
      await client.query(`
        INSERT INTO ${schemaName}.posts (
          canonical_key,
          source_id,
          source_label,
          source_url,
          author_handle,
          post_id,
          post_url,
          created_at,
          first_collected_at,
          last_seen_at,
          content_hash,
          raw_text,
          translated_text,
          detected_language,
          target_language,
          has_video,
          local_dir,
          screenshot_path,
          article_snapshot_path,
          page_snapshot_path,
          payload
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        )
        ON CONFLICT (canonical_key)
        DO UPDATE SET
          last_seen_at = EXCLUDED.last_seen_at,
          payload = EXCLUDED.payload,
          translated_text = EXCLUDED.translated_text,
          detected_language = EXCLUDED.detected_language,
          target_language = EXCLUDED.target_language
      `, [
        record.canonicalKey,
        record.sourceId,
        record.sourceLabel,
        record.sourceUrl,
        record.authorHandle,
        record.postId,
        record.postUrl,
        record.createdAt,
        record.collectedAt,
        record.contentHash,
        record.rawText,
        record.translatedText,
        record.detectedLanguage,
        record.targetLanguage,
        record.hasVideo,
        record.localDir,
        record.screenshotPath,
        record.articleSnapshotPath,
        record.pageSnapshotPath,
        record.payload,
      ]);
    },
    async saveAlert(record) {
      await client.query(`
        INSERT INTO ${schemaName}.alerts (
          alert_key, canonical_key, rule_id, source_id, post_id, post_url, sent_at, payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (alert_key) DO NOTHING
      `, [
        record.alertKey,
        record.canonicalKey,
        record.ruleId,
        record.sourceId,
        record.postId,
        record.postUrl,
        record.sentAt,
        record.payload,
      ]);
    },
    async saveRun(summary) {
      await client.query(`
        INSERT INTO ${schemaName}.runs (run_id, collected_at, payload)
        VALUES ($1, $2, $3)
        ON CONFLICT (run_id) DO NOTHING
      `, [
        summary.runId,
        summary.collectedAt,
        summary,
      ]);
    },
    async close() {
      await client.end();
    },
  };
}

async function createPostgresStore(config) {
  if (!config.database.enabled) {
    return null;
  }

  const client = new Client({
    host: config.database.host,
    port: config.database.port,
    database: config.database.database,
    user: config.database.user,
    password: process.env[config.database.passwordEnv] || undefined,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
  } catch (error) {
    if (config.database.optional) {
      console.warn(`PostgreSQL disabled due to connection failure: ${error.message}`);
      return null;
    }
    throw error;
  }

  const schemaName = quoteIdentifier(config.database.schema);
  await initSchema(client, schemaName);
  return createStore(client, schemaName);
}

module.exports = {
  createPostgresStore,
  initSchema,
};
