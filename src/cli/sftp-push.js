const fs = require('fs');
const SftpClient = require('ssh2-sftp-client');
const { loadConfig } = require('../lib/config');
const { listPreparedBatches, markBatchUploaded, prepareHandoffBatches } = require('../lib/handoff');

function getPassword(config) {
  const envName = config.handoff?.sftp?.passwordEnv;
  return envName ? (process.env[envName] || '') : '';
}

function getPassphrase(config) {
  const envName = config.handoff?.sftp?.privateKeyPassphraseEnv;
  return envName ? (process.env[envName] || '') : '';
}

function loadPrivateKey(config) {
  const privateKeyPath = config.handoff?.sftp?.privateKeyPath || '';
  if (!privateKeyPath) {
    return '';
  }

  return fs.readFileSync(privateKeyPath, 'utf8');
}

function buildConnectionConfig(config) {
  const sftp = config.handoff?.sftp || {};
  const connection = {
    host: sftp.host,
    port: sftp.port || 22,
    username: sftp.username,
    readyTimeout: config.network.timeoutMs,
  };

  const password = getPassword(config);
  const privateKey = loadPrivateKey(config);
  const passphrase = getPassphrase(config);

  if (privateKey) {
    connection.privateKey = privateKey;
    if (passphrase) {
      connection.passphrase = passphrase;
    }
  } else if (password) {
    connection.password = password;
  }

  return connection;
}

async function main() {
  const config = loadConfig();
  if (!config.handoff?.enabled) {
    throw new Error('handoff.enabled is false in config.json');
  }

  const sftpConfig = config.handoff?.sftp || {};
  if (!sftpConfig.enabled) {
    throw new Error('handoff.sftp.enabled is false in config.json');
  }
  if (!sftpConfig.host || !sftpConfig.username || !sftpConfig.remoteDir) {
    throw new Error('Missing SFTP host, username, or remoteDir in config.json');
  }

  prepareHandoffBatches(config);
  const batches = listPreparedBatches(config, { excludeUploaded: true });
  const client = new SftpClient();
  const connection = buildConnectionConfig(config);

  try {
    await client.connect(connection);
    await client.mkdir(sftpConfig.remoteDir, true);

    const uploaded = [];
    for (const batch of batches) {
      const remotePostsPath = `${sftpConfig.remoteDir}/${batch.runId}.posts.ndjson`;
      const remoteManifestPath = `${sftpConfig.remoteDir}/${batch.runId}.manifest.json`;

      await client.put(batch.postsOutPath, remotePostsPath);
      await client.put(batch.manifestOutPath, remoteManifestPath);

      markBatchUploaded(config, batch, {
        remotePostsPath,
        remoteManifestPath,
      });

      uploaded.push({
        runId: batch.runId,
        remotePostsPath,
        remoteManifestPath,
      });
    }

    console.log(JSON.stringify({
      uploadedCount: uploaded.length,
      uploaded,
    }, null, 2));
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
