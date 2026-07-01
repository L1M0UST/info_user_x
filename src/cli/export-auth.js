const path = require('path');
const { loadConfig } = require('../lib/config');
const { configureNetwork } = require('../lib/http');
const { launchAuthenticatedContext, detectLoginState, collectXCookies } = require('../lib/browser');
const { ensureDir, writeJson } = require('../lib/storage');
const { sleep } = require('../lib/utils');

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
    await sleep(config.collection.waitAfterNavigationMs || 4000);
    const loginState = await detectLoginState(page);
    const xCookies = await collectXCookies(context);

    const cookieLoggedIn = xCookies.hasAuthToken && xCookies.hasCt0;
    const isLoggedIn = loginState.loggedIn === true || (loginState.loggedIn === null && cookieLoggedIn);

    if (!isLoggedIn) {
      const debugDir = path.join(config.storage.rootDir, 'runs', 'debug');
      ensureDir(debugDir);
      const stamp = new Date().toISOString().replace(/[:]/g, '-');
      const screenshotPath = path.join(debugDir, `auth-export-failed-${stamp}.png`);
      const htmlPath = path.join(debugDir, `auth-export-failed-${stamp}.html`);

      await page.screenshot({ path: screenshotPath, fullPage: true });
      writeJson(path.join(debugDir, `auth-export-failed-${stamp}.json`), {
        failedAt: new Date().toISOString(),
        url: page.url(),
        title: await page.title(),
        loginState,
        xCookies,
        screenshotPath,
        htmlPath,
      });
      require('fs').writeFileSync(htmlPath, await page.content(), 'utf8');

      throw new Error(`Not logged in: ${JSON.stringify({ loginState, xCookies, screenshotPath, htmlPath })}`);
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
      loginState,
      xCookies,
    }, null, 2));
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
