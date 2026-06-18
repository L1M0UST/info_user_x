const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { sleep } = require('./utils');

function resetDir(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

function copyIfExists(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }

  fs.cpSync(source, destination, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });
}

function prepareRuntimeProfile(config, runtimeUserDataDir) {
  resetDir(runtimeUserDataDir);

  copyIfExists(
    path.join(config.browser.userDataDir, 'Local State'),
    path.join(runtimeUserDataDir, 'Local State')
  );

  copyIfExists(
    path.join(config.browser.userDataDir, config.browser.profileDirectory),
    path.join(runtimeUserDataDir, config.browser.profileDirectory)
  );
}

function buildCommonLaunchOptions(config) {
  const options = {
    headless: Boolean(config.browser.headless),
    viewport: config.browser.viewport,
    proxy: config.network.proxyUrl ? { server: config.network.proxyUrl } : undefined,
    locale: config.browser.locale,
    args: [
      `--profile-directory=${config.browser.profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      ...(config.browser.launchArgs || []),
    ],
  };

  if (config.browser.executablePath) {
    options.executablePath = config.browser.executablePath;
  }

  if (config.browser.channel) {
    options.channel = config.browser.channel;
  }

  return options;
}

async function launchPersistent(config, targetUserDataDir) {
  return chromium.launchPersistentContext(targetUserDataDir, buildCommonLaunchOptions(config));
}

async function launchWithStorageState(config) {
  if (!config.browser.storageStatePath || !fs.existsSync(config.browser.storageStatePath)) {
    throw new Error(`storageStatePath not found: ${config.browser.storageStatePath}`);
  }

  const browser = await chromium.launch(buildCommonLaunchOptions(config));
  const context = await browser.newContext({
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    storageState: config.browser.storageStatePath,
  });

  return {
    context,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function launchAuthenticatedContext(config) {
  if (config.browser.authStrategy === 'storage_state') {
    const launched = await launchWithStorageState(config);
    return {
      ...launched,
      launchMode: 'storage_state',
      fallbackError: null,
    };
  }

  const runtimeUserDataDir = path.join(
    config.storage.rootDir,
    'runtime',
    `edge-user-data-${Date.now()}`
  );
  const errors = [];

  try {
    const context = await launchPersistent(config, config.browser.userDataDir);
    return {
      context,
      launchMode: 'direct_profile',
      fallbackError: null,
      close: async () => {
        await context.close();
      },
    };
  } catch (error) {
    errors.push(`direct_profile: ${error.message}`);
  }

  try {
    prepareRuntimeProfile(config, runtimeUserDataDir);
    const context = await launchPersistent(config, runtimeUserDataDir);
    return {
      context,
      launchMode: 'copied_profile',
      fallbackError: errors.join(' | ') || null,
      close: async () => {
        await context.close();
      },
    };
  } catch (error) {
    errors.push(`copied_profile: ${error.message}`);
  }

  try {
    const launched = await launchWithStorageState(config);
    return {
      ...launched,
      launchMode: 'storage_state_fallback',
      fallbackError: errors.join(' | ') || null,
    };
  } catch (error) {
    errors.push(`storage_state: ${error.message}`);
  }

  throw new Error(`All browser auth strategies failed: ${errors.join(' | ')}`);
}

async function elementExists(page, selector) {
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function detectLoginState(page) {
  const loggedInSignals = [
    '[data-testid="AppTabBar_Home_Link"]',
    '[data-testid="SideNav_AccountSwitcher_Button"]',
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[aria-label="Profile"]',
  ];

  const loggedOutSignals = [
    'a[href="/i/flow/login"]',
    'input[autocomplete="username"]',
    'input[name="text"]',
    'text=Sign in',
  ];

  for (const selector of loggedInSignals) {
    if (await elementExists(page, selector)) {
      return { loggedIn: true, matched: selector };
    }
  }

  for (const selector of loggedOutSignals) {
    if (await elementExists(page, selector)) {
      return { loggedIn: false, matched: selector };
    }
  }

  return { loggedIn: null, matched: 'no known selector matched' };
}

async function collectXCookies(context) {
  await sleep(200);
  const cookies = await context.cookies(['https://x.com', 'https://twitter.com']);
  const names = cookies
    .filter((cookie) => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(cookie.domain))
    .map((cookie) => cookie.name);

  return {
    hasAuthToken: names.includes('auth_token'),
    hasCt0: names.includes('ct0'),
    hasTwid: names.includes('twid'),
    names: [...new Set(names)].sort(),
  };
}

module.exports = {
  collectXCookies,
  detectLoginState,
  launchAuthenticatedContext,
};
