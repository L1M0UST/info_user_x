const { loadConfig } = require('../lib/config');
const { configureNetwork } = require('../lib/http');
const { launchAuthenticatedContext, detectLoginState, collectXCookies } = require('../lib/browser');
const { makeStorage } = require('../lib/storage');
const { createPostgresStore } = require('../lib/postgres');
const { listTimelinePostRefs, collectPostSnapshot } = require('../lib/scrape');
const { translatePost } = require('../lib/llm');
const { sleep } = require('../lib/utils');

async function collectSource(timelinePage, detailPage, source, config, storage) {
  const postRefs = await listTimelinePostRefs(timelinePage, source, config);
  const newPosts = [];
  const skippedPosts = [];

  for (const postRef of postRefs) {
    if (await storage.hasPost(source, postRef.postId)) {
      skippedPosts.push(postRef.postId);
      continue;
    }

    const snapshot = await collectPostSnapshot(detailPage, source, postRef, config);
    const translation = await translatePost(config, snapshot);
    const stored = await storage.storePost(source, snapshot, translation, detailPage);

    newPosts.push({
      postId: snapshot.postId,
      postUrl: snapshot.postUrl,
      createdAt: snapshot.createdAt,
      storageDir: stored.postDir,
      translated: Boolean(translation && translation.translatedText),
      mediaCount: snapshot.media.images.length,
      linkCount: snapshot.links.length,
    });
  }

  await storage.markSourceChecked(source, {
    checkedPosts: postRefs.length,
    newPosts: newPosts.length,
    skippedPosts: skippedPosts.length,
    lastCheckedUrl: source.url,
  });

  return {
    sourceId: source.id,
    label: source.label,
    url: source.url,
    checkedPosts: postRefs.length,
    newPosts,
    skippedPosts,
  };
}

async function main() {
  const config = loadConfig();
  configureNetwork(config);

  if (!config.enabledSources.length) {
    throw new Error('No enabled sources found in config.json');
  }

  const postgresStore = await createPostgresStore(config);
  const storage = await makeStorage(config, postgresStore);
  const { context, launchMode, fallbackError, close } = await launchAuthenticatedContext(config);

  try {
    const timelinePage = context.pages()[0] || await context.newPage();
    const detailPage = await context.newPage();

    await timelinePage.goto('https://x.com/home', {
      waitUntil: 'domcontentloaded',
      timeout: config.network.timeoutMs,
    });
    await sleep(config.collection.waitAfterNavigationMs);

    const loginState = await detectLoginState(timelinePage);
    const xCookies = await collectXCookies(context);

    if (!loginState.loggedIn) {
      throw new Error(`X login check failed: ${JSON.stringify({ loginState, xCookies })}`);
    }

    if (config.storage.exportStorageStatePath) {
      await context.storageState({ path: config.storage.exportStorageStatePath });
    }

    const sourceResults = [];
    for (const source of config.enabledSources) {
      sourceResults.push(await collectSource(timelinePage, detailPage, source, config, storage));
    }

    const summary = {
      collectedAt: new Date().toISOString(),
      engine: config.browser.engine,
      launchMode,
      fallbackError: fallbackError || null,
      loginState,
      xCookies,
      proxyUrl: config.network.proxyUrl || null,
      sourceResults,
      exportStorageStatePath: config.storage.exportStorageStatePath || null,
    };

    const summaryPath = await storage.writeRunSummary(summary);
    console.log(JSON.stringify({
      ...summary,
      summaryPath,
    }, null, 2));
  } finally {
    await close();
    if (postgresStore) {
      await postgresStore.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
