const { loadConfig } = require('../lib/config');
const { configureNetwork } = require('../lib/http');
const { launchAuthenticatedContext, detectLoginState, collectXCookies } = require('../lib/browser');
const { ensureDir, writeJson } = require('../lib/storage');
const { sleep } = require('../lib/utils');

async function main() {
  const config = loadConfig();
  configureNetwork(config);
  ensureDir(config.storage.rootDir);

  const { context, launchMode, fallbackError, close } = await launchAuthenticatedContext(config);

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('https://x.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: config.network.timeoutMs,
    });
    await sleep(config.collection.waitAfterNavigationMs);

    const loginState = await detectLoginState(page);
    const xCookies = await collectXCookies(context);

    if (config.storage.exportStorageStatePath) {
      await context.storageState({ path: config.storage.exportStorageStatePath });
    }

    const output = {
      checkedAt: new Date().toISOString(),
      launchMode,
      fallbackError: fallbackError || null,
      loginState,
      xCookies,
      exportStorageStatePath: config.storage.exportStorageStatePath || null,
    };

    writeJson(config.storage.loginCheckPath, output);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
