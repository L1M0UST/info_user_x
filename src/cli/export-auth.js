const path = require('path');
const { loadConfig } = require('../lib/config');
const { configureNetwork } = require('../lib/http');
const { launchAuthenticatedContext, detectLoginState } = require('../lib/browser');
const { ensureDir, writeJson } = require('../lib/storage');

async function main() {
  const config = loadConfig();
  configureNetwork(config);
  ensureDir(config.storage.rootDir);

  const { context, launchMode, close } = await launchAuthenticatedContext(config);
  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: config.network.timeoutMs,
    });
    const loginState = await detectLoginState(page);
    if (!loginState.loggedIn) {
      throw new Error(`Not logged in: ${JSON.stringify(loginState)}`);
    }

    ensureDir(path.dirname(config.storage.exportStorageStatePath));
    await context.storageState({ path: config.storage.exportStorageStatePath });
    const bundlePath = config.storage.exportStorageStatePath.replace(/\.json$/i, '.bundle.json');
    writeJson(bundlePath, {
      exportedAt: new Date().toISOString(),
      storageStatePath: config.storage.exportStorageStatePath,
      launchMode,
      notes: 'Copy storage-state.json to Linux server and switch authStrategy to storage_state.',
    });

    console.log(JSON.stringify({
      exportedAt: new Date().toISOString(),
      storageStatePath: config.storage.exportStorageStatePath,
      bundlePath,
      launchMode,
    }, null, 2));
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
