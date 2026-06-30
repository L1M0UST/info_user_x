const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { captureArticleScreenshot, materializeSnapshot } = require('./scrape');
const { normalizeWhitespace, sanitizeSlug } = require('./utils');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function migrateLegacyState(state) {
  if (!state) {
    return state;
  }

  if (state.version === 3) {
    return state;
  }

  if (state.version === 2) {
    return {
      ...state,
      version: 3,
      alerts: state.alerts || {},
    };
  }

  const migrated = {
    version: 3,
    sources: {},
    posts: {},
    alerts: {},
  };

  for (const [authorHandle, authorState] of Object.entries(state.authors || {})) {
    migrated.sources[authorHandle] = {
      id: authorHandle,
      label: authorState.label || authorHandle,
      lastCheckedAt: authorState.lastCheckedAt || null,
      lastCheckedUrl: authorState.profileUrl || null,
      checkedPosts: authorState.lastResultCount || 0,
      newPosts: authorState.lastNewCount || 0,
      skippedPosts: 0,
    };
  }

  for (const [legacyKey, postState] of Object.entries(state.posts || {})) {
    migrated.posts[legacyKey] = {
      canonicalKey: legacyKey,
      sourceId: postState.authorHandle,
      postId: postState.postId,
      postUrl: postState.postUrl,
      createdAt: postState.createdAt,
      collectedAt: postState.collectedAt,
      postDir: postState.postDir,
      contentHash: postState.textHash || '',
    };
  }

  return migrated;
}

function createEmptyState() {
  return {
    version: 3,
    sources: {},
    posts: {},
    alerts: {},
  };
}

function buildCanonicalKey(source, postId) {
  return `${source.id}:${postId}`;
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function buildPostDir(rootDir, source, snapshot) {
  const safeDate = snapshot.createdAt ? snapshot.createdAt.slice(0, 10) : 'unknown-date';
  const safeStamp = snapshot.createdAt
    ? snapshot.createdAt.replace(/[:]/g, '-').replace(/\.\d+Z$/, 'Z')
    : `collected-${new Date().toISOString().replace(/[:]/g, '-')}`;

  return path.join(
    rootDir,
    'sources',
    sanitizeSlug(source.slug || source.id),
    'posts',
    safeDate,
    `${safeStamp}_${snapshot.postId}`
  );
}

function toRelative(rootDir, filePath) {
  if (!filePath) {
    return null;
  }

  return path.relative(rootDir, filePath);
}

async function makeStorage(config, postgresStore) {
  const rootDir = config.storage.rootDir;
  const statePath = path.join(rootDir, 'state', 'index.json');
  const runsDir = path.join(rootDir, 'runs');

  ensureDir(rootDir);
  ensureDir(runsDir);
  ensureDir(path.dirname(statePath));

  const existingState = readJson(statePath, createEmptyState());
  const state = migrateLegacyState(existingState) || createEmptyState();
  if (state.version !== 3) {
    state.version = 3;
  }
  if (!state.alerts) {
    state.alerts = {};
  }
  writeJson(statePath, state);

  const runExports = [];

  async function saveState() {
    writeJson(statePath, state);
  }

  async function hasPost(source, postId) {
    const canonicalKey = buildCanonicalKey(source, postId);
    if (state.posts[canonicalKey]) {
      return true;
    }

    if (postgresStore) {
      return postgresStore.hasPost(canonicalKey);
    }

    return false;
  }

  async function hasAlert(alertKey) {
    return Boolean(state.alerts[alertKey]);
  }

  async function markAlertSent(record) {
    state.alerts[record.alertKey] = {
      alertKey: record.alertKey,
      canonicalKey: record.canonicalKey,
      ruleId: record.ruleId,
      sourceId: record.sourceId,
      postId: record.postId,
      postUrl: record.postUrl,
      sentAt: record.sentAt,
    };
    await saveState();
  }

  async function markSourceChecked(source, status) {
    state.sources[source.id] = {
      ...(state.sources[source.id] || {}),
      id: source.id,
      label: source.label,
      url: source.url,
      lastCheckedAt: new Date().toISOString(),
      checkedPosts: status.checkedPosts,
      newPosts: status.newPosts,
      skippedPosts: status.skippedPosts,
      lastCheckedUrl: status.lastCheckedUrl,
    };
    await saveState();
  }

  async function storePost(source, snapshot, translation, detailPage) {
    const canonicalKey = buildCanonicalKey(source, snapshot.postId);
    const postDir = buildPostDir(rootDir, source, snapshot);
    ensureDir(postDir);

    const originalTextPath = path.join(postDir, 'original.txt');
    const translatedTextPath = path.join(postDir, `translated.${config.llm.targetLanguage}.txt`);
    const translationJsonPath = path.join(postDir, 'translation.json');
    const postJsonPath = path.join(postDir, 'post.json');

    fs.writeFileSync(originalTextPath, `${normalizeWhitespace(snapshot.text.original)}\n`, 'utf8');

    if (translation && translation.translatedText) {
      fs.writeFileSync(translatedTextPath, `${normalizeWhitespace(translation.translatedText)}\n`, 'utf8');
      writeJson(translationJsonPath, translation);
    }

    if (detailPage && config.collection.saveScreenshot) {
      snapshot.snapshots.screenshotPath = await captureArticleScreenshot(
        detailPage,
        source,
        snapshot.postId,
        postDir
      );
    }

    await materializeSnapshot(postDir, snapshot, config, source);

    const payload = {
      source: {
        id: source.id,
        label: source.label,
        url: source.url,
        handle: source.handle,
      },
      post: snapshot,
      translation: translation || null,
      storage: {
        postDir,
        originalTextPath,
        translatedTextPath: translation && translation.translatedText ? translatedTextPath : null,
        translationJsonPath: translation && translation.translatedText ? translationJsonPath : null,
      },
      reproduction: {
        postUrl: snapshot.postUrl,
        canonicalUrl: snapshot.canonicalUrl,
        screenshotPath: snapshot.snapshots.screenshotPath,
        articleSnapshotPath: snapshot.snapshots.articleSnapshotPath,
        pageSnapshotPath: snapshot.snapshots.pageSnapshotPath,
      },
      storedAt: new Date().toISOString(),
    };

    writeJson(postJsonPath, payload);

    const ingestRecord = {
      schemaVersion: 1,
      canonicalKey,
      source: payload.source,
      post: {
        postId: snapshot.postId,
        postUrl: snapshot.postUrl,
        canonicalUrl: snapshot.canonicalUrl,
        createdAt: snapshot.createdAt,
        authorHandle: snapshot.authorHandle,
        pageLang: snapshot.pageLang,
        originalText: snapshot.text.original,
        translatedText: translation?.translatedText || '',
        detectedLanguage: translation?.detectedLanguage || snapshot.pageLang || 'unknown',
        targetLanguage: translation?.targetLanguage || config.llm.targetLanguage,
        hashtags: snapshot.hashtags,
        mentions: snapshot.mentions,
        quotedPostUrls: snapshot.quotedPostUrls,
        links: snapshot.links,
        hasVideo: snapshot.media.hasVideo,
        videoPostUrl: snapshot.media.videoPostUrl,
        uiState: snapshot.uiState,
      },
      localFiles: {
        postDir: toRelative(rootDir, postDir),
        postJsonPath: toRelative(rootDir, postJsonPath),
        originalTextPath: toRelative(rootDir, originalTextPath),
        translatedTextPath: translation && translation.translatedText ? toRelative(rootDir, translatedTextPath) : null,
        translationJsonPath: translation && translation.translatedText ? toRelative(rootDir, translationJsonPath) : null,
        screenshotPath: toRelative(rootDir, snapshot.snapshots.screenshotPath),
        articleSnapshotPath: toRelative(rootDir, snapshot.snapshots.articleSnapshotPath),
        pageSnapshotPath: toRelative(rootDir, snapshot.snapshots.pageSnapshotPath),
        mediaFiles: snapshot.media.downloadedImages.map((item) => ({
          ...item,
          localPath: toRelative(rootDir, item.localPath),
        })),
      },
      downstream: {
        archiveReady: true,
        transferRecommended: 'sftp',
        ftpConsumerCompatible: true,
      },
    };
    writeJson(path.join(postDir, 'ingest-record.json'), ingestRecord);
    runExports.push(ingestRecord);

    const contentHash = sha1(`${snapshot.postId}\n${snapshot.text.original}\n${translation?.translatedText || ''}`);
    const collectedAt = new Date().toISOString();

    state.posts[canonicalKey] = {
      canonicalKey,
      sourceId: source.id,
      postId: snapshot.postId,
      postUrl: snapshot.postUrl,
      createdAt: snapshot.createdAt,
      collectedAt,
      postDir,
      contentHash,
    };
    await saveState();

    if (postgresStore) {
      await postgresStore.savePost({
        canonicalKey,
        sourceId: source.id,
        sourceLabel: source.label,
        sourceUrl: source.url,
        authorHandle: snapshot.authorHandle,
        postId: snapshot.postId,
        postUrl: snapshot.postUrl,
        createdAt: snapshot.createdAt,
        collectedAt,
        contentHash,
        rawText: snapshot.text.original,
        translatedText: translation?.translatedText || '',
        detectedLanguage: translation?.detectedLanguage || snapshot.pageLang || 'unknown',
        targetLanguage: translation?.targetLanguage || config.llm.targetLanguage,
        hasVideo: snapshot.media.hasVideo,
        localDir: postDir,
        screenshotPath: snapshot.snapshots.screenshotPath,
        articleSnapshotPath: snapshot.snapshots.articleSnapshotPath,
        pageSnapshotPath: snapshot.snapshots.pageSnapshotPath,
        payload,
      });
    }

    return {
      canonicalKey,
      postDir,
      postJsonPath,
      ingestRecord,
    };
  }

  async function writeRunSummary(summary) {
    const stamp = summary.collectedAt.replace(/[:]/g, '-');
    const summaryPath = path.join(runsDir, `${stamp}.json`);
    const runRecord = {
      runId: stamp,
      ...summary,
    };

    writeJson(summaryPath, runRecord);
    writeJson(path.join(runsDir, 'latest.json'), runRecord);

    const exportDir = path.join(rootDir, 'exports', stamp);
    ensureDir(exportDir);
    const ndjsonPath = path.join(exportDir, 'posts.ndjson');
    const manifestPath = path.join(exportDir, 'manifest.json');
    fs.writeFileSync(
      ndjsonPath,
      runExports.map((item) => JSON.stringify(item)).join('\n') + (runExports.length ? '\n' : ''),
      'utf8'
    );
    writeJson(manifestPath, {
      generatedAt: runRecord.collectedAt,
      runId: runRecord.runId,
      postCount: runExports.length,
      ndjsonPath: toRelative(rootDir, ndjsonPath),
      summaryPath: toRelative(rootDir, summaryPath),
    });

    if (postgresStore) {
      await postgresStore.saveRun(runRecord);
    }

    return summaryPath;
  }

  return {
    hasAlert,
    hasPost,
    markAlertSent,
    markSourceChecked,
    state,
    statePath,
    storePost,
    writeRunSummary,
  };
}

module.exports = {
  ensureDir,
  makeStorage,
  readJson,
  writeJson,
};
