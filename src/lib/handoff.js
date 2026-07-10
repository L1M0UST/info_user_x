const fs = require('fs');
const path = require('path');
const { ensureDir, readJson, writeJson } = require('./storage');
const { normalizeWhitespace } = require('./utils');

function getHandoffPaths(config) {
  const handoff = config.handoff || {};
  return {
    outboxDir: handoff.outboxDir,
    sentDir: handoff.sentDir,
    statePath: handoff.statePath,
    exportDir: path.join(config.storage.rootDir, 'exports'),
  };
}

function createEmptyHandoffState() {
  return {
    version: 1,
    preparedBatches: {},
    uploadedBatches: {},
  };
}

function loadHandoffState(config) {
  const { statePath } = getHandoffPaths(config);
  const state = readJson(statePath, createEmptyHandoffState());
  if (!state.version) {
    state.version = 1;
  }
  if (!state.preparedBatches) {
    state.preparedBatches = {};
  }
  if (!state.uploadedBatches) {
    state.uploadedBatches = {};
  }
  return state;
}

function saveHandoffState(config, state) {
  const { statePath } = getHandoffPaths(config);
  writeJson(statePath, state);
}

function listExportBatches(config) {
  const { exportDir } = getHandoffPaths(config);
  if (!fs.existsSync(exportDir)) {
    return [];
  }

  return fs.readdirSync(exportDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runId = entry.name;
      const batchDir = path.join(exportDir, runId);
      const postsPath = path.join(batchDir, 'posts.ndjson');
      const manifestPath = path.join(batchDir, 'manifest.json');
      if (!fs.existsSync(postsPath) || !fs.existsSync(manifestPath)) {
        return null;
      }

      return {
        runId,
        batchDir,
        postsPath,
        manifestPath,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

function buildOutboxFileNames(runId) {
  return {
    postsFileName: `info_user_x_${runId}.posts.ndjson`,
    manifestFileName: `info_user_x_${runId}.manifest.json`,
  };
}

function normalizeHandoffRecord(record, sourceManifest) {
  const normalized = { ...record };
  normalized.collectedAt = normalized.collectedAt || sourceManifest.generatedAt || new Date().toISOString();
  normalized.post = {
    ...(normalized.post || {}),
  };
  normalized.post.rawContentForLLM = normalized.post.rawContentForLLM || [
    normalized.post.originalText ? `Original:\n${normalized.post.originalText}` : '',
    normalized.post.translatedText ? `Translated:\n${normalized.post.translatedText}` : '',
  ].filter(Boolean).join('\n\n');
  normalized.post.originalText = normalizeWhitespace(normalized.post.originalText || '');
  normalized.post.translatedText = normalizeWhitespace(normalized.post.translatedText || '');
  normalized.translation = normalized.translation || null;
  return normalized;
}

function prepareHandoffBatches(config, options = {}) {
  const { outboxDir, sentDir } = getHandoffPaths(config);
  ensureDir(outboxDir);
  ensureDir(sentDir);

  const state = loadHandoffState(config);
  const exportBatches = listExportBatches(config);
  const selected = options.latestOnly && exportBatches.length
    ? [exportBatches[exportBatches.length - 1]]
    : exportBatches;

  const prepared = [];
  for (const batch of selected) {
    const names = buildOutboxFileNames(batch.runId);
    const postsOutPath = path.join(outboxDir, names.postsFileName);
    const manifestOutPath = path.join(outboxDir, names.manifestFileName);
    const sourceManifest = readJson(batch.manifestPath, {});

    const manifest = {
      schemaVersion: 1,
      runId: batch.runId,
      generatedAt: sourceManifest.generatedAt || null,
      postCount: sourceManifest.postCount || 0,
      sourcePostsPath: batch.postsPath,
      outboxPostsFile: names.postsFileName,
      createdAt: new Date().toISOString(),
    };

    const normalizedLines = fs.readFileSync(batch.postsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.stringify(
        normalizeHandoffRecord(JSON.parse(line), sourceManifest)
      ));
    fs.writeFileSync(postsOutPath, `${normalizedLines.join('\n')}${normalizedLines.length ? '\n' : ''}`, 'utf8');
    writeJson(manifestOutPath, manifest);

    state.preparedBatches[batch.runId] = {
      runId: batch.runId,
      postsOutPath,
      manifestOutPath,
      preparedAt: new Date().toISOString(),
    };

    prepared.push({
      runId: batch.runId,
      postsOutPath,
      manifestOutPath,
      postsFileName: names.postsFileName,
      manifestFileName: names.manifestFileName,
    });
  }

  saveHandoffState(config, state);
  return prepared;
}

function listPreparedBatches(config, options = {}) {
  const { outboxDir } = getHandoffPaths(config);
  ensureDir(outboxDir);
  const state = loadHandoffState(config);
  const prepared = Object.values(state.preparedBatches)
    .filter((item) => fs.existsSync(item.postsOutPath) && fs.existsSync(item.manifestOutPath))
    .sort((left, right) => left.runId.localeCompare(right.runId));

  if (options.excludeUploaded) {
    return prepared.filter((item) => !state.uploadedBatches[item.runId]);
  }

  return prepared;
}

function markBatchUploaded(config, batch, remoteInfo) {
  const state = loadHandoffState(config);
  state.uploadedBatches[batch.runId] = {
    runId: batch.runId,
    uploadedAt: new Date().toISOString(),
    remoteInfo,
  };
  saveHandoffState(config, state);
}

module.exports = {
  getHandoffPaths,
  listPreparedBatches,
  loadHandoffState,
  markBatchUploaded,
  prepareHandoffBatches,
};
