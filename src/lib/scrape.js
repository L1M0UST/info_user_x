const fs = require('fs');
const path = require('path');
const { downloadToFile } = require('./http');
const {
  normalizeWhitespace,
  rewriteTwitterMediaUrl,
  safeExtensionFromContentType,
  safeExtensionFromUrl,
  sleep,
} = require('./utils');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function waitForPostReady(page, config) {
  const selectors = [
    '[data-testid="primaryColumn"]',
    'article[data-testid="tweet"]',
    '[data-testid="tweetText"]',
  ];

  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, {
        timeout: Math.min(config.network.timeoutMs, 12000),
      });
      return selector;
    } catch {
      // try next selector
    }
  }

  return null;
}

function buildCandidatePostUrls(source, postRef) {
  const urls = [
    postRef.postUrl,
    `https://x.com/i/web/status/${postRef.postId}`,
    `https://twitter.com/${source.handle || ''}/status/${postRef.postId}`.replace(/\/{2,}/g, '/').replace('https:/', 'https://'),
    `https://twitter.com/i/web/status/${postRef.postId}`,
  ];

  return [...new Set(urls)];
}

async function expandFoldedContent(page) {
  const labels = ['Show more', 'View', 'Yes, view profile', '显示更多', '查看', '展开'];
  const clicked = [];

  for (const label of labels) {
    const locator = page.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }).first();
    try {
      if (await locator.isVisible({ timeout: 250 })) {
        await locator.click({ timeout: 1000 });
        clicked.push(label);
        await sleep(300);
      }
    } catch {
      // ignore
    }
  }

  return clicked;
}

async function listTimelinePostRefs(page, source, config) {
  await page.goto(source.url, {
    waitUntil: 'domcontentloaded',
    timeout: config.network.timeoutMs,
  });
  await sleep(config.collection.waitAfterNavigationMs);

  let stablePasses = 0;
  while (stablePasses < config.collection.maxScrollRounds) {
    const count = await page.locator('article[data-testid="tweet"]').count();
    if (count >= source.maxPosts) {
      break;
    }

    await page.mouse.wheel(0, 2200);
    await sleep(1400);

    const nextCount = await page.locator('article[data-testid="tweet"]').count();
    stablePasses = nextCount === count ? stablePasses + 1 : 0;
  }

  return page.evaluate(({ sourceHandle, maxPosts }) => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const items = [];
    const seen = new Set();

    for (const article of articles) {
      const anchors = Array.from(article.querySelectorAll('a[href*="/status/"]'));
      const statusAnchor = anchors.find((anchor) => {
        const href = anchor.getAttribute('href') || '';
        if (sourceHandle) {
          return href.includes(`/${sourceHandle}/status/`);
        }
        return /\/status\/\d+/.test(href);
      });

      if (!statusAnchor) {
        continue;
      }

      const href = statusAnchor.getAttribute('href') || '';
      const match = href.match(/status\/(\d+)/);
      if (!match) {
        continue;
      }

      const postId = match[1];
      if (seen.has(postId)) {
        continue;
      }
      seen.add(postId);

      items.push({
        postId,
        postUrl: href.startsWith('http') ? href : `https://x.com${href}`,
      });

      if (items.length >= maxPosts) {
        break;
      }
    }

    return items;
  }, {
    sourceHandle: source.handle,
    maxPosts: source.maxPosts,
  });
}

async function extractPostDataFromPage(page, source, postRef) {
  return page.evaluate(({ sourceHandle, postId, postUrl }) => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const exactArticle = articles.find((candidate) => {
      return Array.from(candidate.querySelectorAll('a[href*="/status/"]')).some((anchor) => {
        const href = anchor.getAttribute('href') || '';
        const samePost = href.includes(`/status/${postId}`);
        const sameHandle = sourceHandle ? href.includes(`/${sourceHandle}/status/`) : true;
        return samePost && sameHandle;
      });
    });

    const samePostAnyHandleArticle = articles.find((candidate) => {
      return Array.from(candidate.querySelectorAll('a[href*="/status/"]')).some((anchor) => {
        const href = anchor.getAttribute('href') || '';
        return href.includes(`/status/${postId}`);
      });
    });

    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    const primaryColumnArticle = primaryColumn
      ? Array.from(primaryColumn.querySelectorAll('article[data-testid="tweet"]'))
        .find((candidate) => candidate.querySelector('[data-testid="tweetText"], time'))
      : null;

    const firstTweetArticle = articles.find((candidate) => candidate.querySelector('[data-testid="tweetText"], time'));
    const article = exactArticle || samePostAnyHandleArticle || primaryColumnArticle || firstTweetArticle || null;

    if (!article) {
      return {
        found: false,
        diagnostics: {
          articleCount: articles.length,
          primaryColumnExists: Boolean(primaryColumn),
          title: document.title,
          url: window.location.href,
        },
      };
    }

    const hrefs = Array.from(article.querySelectorAll('a[href]')).map((anchor) => ({
      url: anchor.href,
      text: (anchor.textContent || '').trim(),
      ariaLabel: anchor.getAttribute('aria-label') || '',
    }));

    const imageUrls = Array.from(article.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
      .map((img) => img.src)
      .filter(Boolean);

    const authorHandleNode = Array.from(article.querySelectorAll('a[href^="/"]'))
      .find((anchor) => /^\/[^/]+$/.test(anchor.getAttribute('href') || ''));

    const tweetTextNode = article.querySelector('[data-testid="tweetText"]');
    const timeNode = article.querySelector('time');
    const videoDetected = Boolean(
      article.querySelector('video') ||
      article.querySelector('[data-testid="videoPlayer"]')
    );

    return {
      found: true,
      matchReason: exactArticle
        ? 'exact_handle_and_post'
        : samePostAnyHandleArticle
          ? 'same_post_any_handle'
          : primaryColumnArticle
            ? 'primary_column_fallback'
            : 'first_tweet_fallback',
      postId,
      postUrl,
      canonicalUrl: window.location.href,
      pageTitle: document.title,
      pageLang: document.documentElement.lang || null,
      authorHandle: authorHandleNode
        ? (authorHandleNode.getAttribute('href') || '').replace(/^\//, '')
        : sourceHandle || null,
      createdAt: timeNode ? timeNode.getAttribute('datetime') : null,
      textOriginal: tweetTextNode ? tweetTextNode.innerText : '',
      articleHtml: article.outerHTML,
      pageHtml: document.documentElement.outerHTML,
      links: hrefs,
      imageUrls,
      videoDetected,
      quotedPostUrls: hrefs
        .map((item) => item.url)
        .filter((url) => /\/status\/\d+/.test(url) && !url.includes(`/status/${postId}`)),
      hashtags: hrefs.map((item) => item.text).filter((text) => text.startsWith('#')),
      mentions: hrefs.map((item) => item.text).filter((text) => text.startsWith('@')),
    };
  }, {
    sourceHandle: source.handle,
    postId: postRef.postId,
    postUrl: postRef.postUrl,
  });
}

async function tryExtractFromCurrentPage(page, source, postRef, config) {
  await waitForPostReady(page, config);
  await sleep(config.collection.waitAfterNavigationMs);
  const expandActions = await expandFoldedContent(page);
  const extracted = await extractPostDataFromPage(page, source, postRef);
  return { expandActions, extracted };
}

async function captureArticleScreenshot(page, source, postId, postDir) {
  const selector = `article[data-testid="tweet"]:has(a[href*="/status/${postId}"])`;
  const locator = page.locator(selector).first();
  if ((await locator.count()) >= 1) {
    const outputPath = path.join(postDir, 'tweet.png');
    await locator.screenshot({ path: outputPath });
    return outputPath;
  }

  const fallbackLocator = page.locator('[data-testid="primaryColumn"] article[data-testid="tweet"]').first();
  if ((await fallbackLocator.count()) >= 1) {
    const outputPath = path.join(postDir, 'tweet.png');
    await fallbackLocator.screenshot({ path: outputPath });
    return outputPath;
  }

  return null;
}

async function downloadImages(imageUrls, mediaDir, config) {
  ensureDir(mediaDir);
  const results = [];

  for (let index = 0; index < imageUrls.length; index += 1) {
    const rawUrl = imageUrls[index];
    const url = rewriteTwitterMediaUrl(rawUrl);
    const fallbackExtension = safeExtensionFromUrl(url) || '.jpg';
    const tempPath = path.join(mediaDir, `image-${String(index + 1).padStart(2, '0')}${fallbackExtension}`);
    const metadata = await downloadToFile(url, tempPath, config);
    const exactExtension = safeExtensionFromContentType(metadata.contentType) || fallbackExtension;
    const finalPath = tempPath.endsWith(exactExtension)
      ? tempPath
      : tempPath.replace(new RegExp(`${fallbackExtension.replace('.', '\\.')}$`), exactExtension);

    if (finalPath !== tempPath) {
      fs.renameSync(tempPath, finalPath);
    }

    results.push({
      sourceUrl: rawUrl,
      downloadedUrl: url,
      localPath: finalPath,
      contentType: metadata.contentType,
      byteLength: metadata.byteLength,
    });
  }

  return results;
}

async function collectPostSnapshot(page, source, postRef, config, fallbackTimelinePage) {
  let expandActions = [];
  let extracted = null;
  let lastDiagnostics = null;
  const triedUrls = [];
  let captureMode = 'detail';

  for (const candidateUrl of buildCandidatePostUrls(source, postRef)) {
    triedUrls.push(candidateUrl);
    await page.goto(candidateUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.network.timeoutMs,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await tryExtractFromCurrentPage(page, source, postRef, config);
      expandActions = result.expandActions;
      extracted = result.extracted;

      if (extracted?.found) {
        break;
      }

      lastDiagnostics = extracted?.diagnostics || null;
      await page.mouse.wheel(0, -1200);
      await sleep(500 + attempt * 500);
    }

    if (extracted?.found) {
      break;
    }
  }

  if (!extracted?.found && fallbackTimelinePage) {
    const timelineResult = await tryExtractFromCurrentPage(fallbackTimelinePage, source, postRef, config);
    expandActions = timelineResult.expandActions;
    extracted = timelineResult.extracted;
    captureMode = 'timeline_fallback';
    if (!extracted?.found) {
      lastDiagnostics = extracted?.diagnostics || null;
    }
  }

  if (!extracted?.found) {
    const debugDir = path.join(config.storage.rootDir, 'runs', 'debug');
    ensureDir(debugDir);
    const stamp = new Date().toISOString().replace(/[:]/g, '-');
    const screenshotPath = path.join(debugDir, `collect-failed-${source.id}-${postRef.postId}-${stamp}.png`);
    const htmlPath = path.join(debugDir, `collect-failed-${source.id}-${postRef.postId}-${stamp}.html`);
    const jsonPath = path.join(debugDir, `collect-failed-${source.id}-${postRef.postId}-${stamp}.json`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');
    writeJson(jsonPath, {
      failedAt: new Date().toISOString(),
      sourceId: source.id,
      sourceUrl: source.url,
      postRef,
      triedUrls,
      pageUrl: page.url(),
      pageTitle: await page.title(),
      expandActions,
      diagnostics: lastDiagnostics,
      screenshotPath,
      htmlPath,
    });

    throw new Error(`Failed to locate target tweet article for ${postRef.postUrl}; debug: ${jsonPath}`);
  }

  return {
    sourceId: source.id,
    sourceLabel: source.label,
    sourceUrl: source.url,
    sourceHandle: source.handle,
    postId: extracted.postId,
    postUrl: extracted.postUrl,
    canonicalUrl: extracted.canonicalUrl,
    createdAt: extracted.createdAt,
    authorHandle: extracted.authorHandle || source.handle,
    pageTitle: extracted.pageTitle,
    pageLang: extracted.pageLang,
    text: {
      original: normalizeWhitespace(extracted.textOriginal),
    },
    links: extracted.links,
    hashtags: extracted.hashtags,
    mentions: extracted.mentions,
    quotedPostUrls: extracted.quotedPostUrls,
    media: {
      images: extracted.imageUrls,
      hasVideo: extracted.videoDetected,
      videoPostUrl: extracted.videoDetected ? extracted.postUrl : null,
      downloadedImages: [],
    },
    snapshots: {
      articleHtml: extracted.articleHtml,
      pageHtml: extracted.pageHtml,
      screenshotPath: null,
      articleSnapshotPath: null,
      pageSnapshotPath: null,
    },
    uiState: {
      expandActions,
      hadFoldIndicators: expandActions.length > 0,
      articleMatchReason: extracted.matchReason,
      captureMode,
      triedUrls,
    },
  };
}

async function materializeSnapshot(postDir, snapshot, config, source) {
  if (config.collection.saveHtmlSnapshot) {
    const articleSnapshotPath = path.join(postDir, 'article.html');
    fs.writeFileSync(articleSnapshotPath, snapshot.snapshots.articleHtml, 'utf8');
    snapshot.snapshots.articleSnapshotPath = articleSnapshotPath;
  }

  if (config.collection.savePageSnapshot) {
    const pageSnapshotPath = path.join(postDir, 'page.html');
    fs.writeFileSync(pageSnapshotPath, snapshot.snapshots.pageHtml, 'utf8');
    snapshot.snapshots.pageSnapshotPath = pageSnapshotPath;
  }

  if (config.collection.downloadImages && snapshot.media.images.length > 0) {
    const mediaDir = path.join(postDir, 'media');
    snapshot.media.downloadedImages = await downloadImages(snapshot.media.images, mediaDir, config);
  }

  writeJson(path.join(postDir, 'links.json'), {
    links: snapshot.links,
    hashtags: snapshot.hashtags,
    mentions: snapshot.mentions,
    quotedPostUrls: snapshot.quotedPostUrls,
    source: {
      id: source.id,
      label: source.label,
      url: source.url,
    },
  });
}

module.exports = {
  captureArticleScreenshot,
  collectPostSnapshot,
  listTimelinePostRefs,
  materializeSnapshot,
};
