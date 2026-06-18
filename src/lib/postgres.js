const { Client } = require('pg');

function quoteIdentifier(identifier) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }

  return `"${identifier}"`;
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
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
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
    CREATE TABLE IF NOT EXISTS ${schemaName}.runs (
      run_id TEXT PRIMARY KEY,
      collected_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )
  `);

  return {
    async hasPost(canonicalKey) {
      const result = await client.query(
        `SELECT 1 FROM ${schemaName}.posts WHERE canonical_key = $1 LIMIT 1`,
        [canonicalKey]
      );
      return result.rowCount > 0;
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

module.exports = {
  createPostgresStore,
};
