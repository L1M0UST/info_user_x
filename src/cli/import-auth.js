const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../lib/config');
const { ensureDir } = require('../lib/storage');

async function main() {
  const sourceFile = process.argv[2];
  if (!sourceFile) {
    throw new Error('Usage: node src/cli/import-auth.js <storage-state.json>');
  }

  const config = loadConfig();
  const inputPath = path.resolve(sourceFile);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  ensureDir(path.dirname(config.browser.storageStatePath));
  fs.copyFileSync(inputPath, config.browser.storageStatePath);

  console.log(JSON.stringify({
    importedAt: new Date().toISOString(),
    inputPath,
    storageStatePath: config.browser.storageStatePath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
