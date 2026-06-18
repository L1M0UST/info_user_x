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

  const refs = await page.evaluate(({ sourceHandle, maxPosts }) => {
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

  return refs;
}

async function extractPostDataFromPage(page, source, postRef) {
  return page.evaluate(({ sourceHandle, postId, postUrl }) => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const article = articles.find((candidate) => {
      return Array.from(candidate.querySelectorAll('a[href*="/status/"]'))
        .some((anchor) => {
          const href = anchor.getAttribute('href') || '';
          const samePost = href.includes(`/status/${postId}`);
          const sameHandle = sourceHandle ? href.includes(`/${sourceHandle}/status/`) : true;
          return samePost && sameHandle;
        });
    });

    if (!article) {
      return null;
    }

    const hrefs = Array.from(article.querySelectorAll('a[href]')).map((anchor) => {
      return {
        url: anchor.href,
        text: (anchor.textContent || '').trim(),
        ariaLabel: anchor.getAttribute('aria-label') || '',
      };
    });

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
      hashtags: hrefs
        .map((item) => item.text)
        .filter((text) => text.startsWith('#')),
      mentions: hrefs
        .map((item) => item.text)
        .filter((text) => text.startsWith('@')),
    };
  }, {
    sourceHandle: source.handle,
    postId: postRef.postId,
    postUrl: postRef.postUrl,
  });
}

async function captureArticleScreenshot(page, source, postId, postDir) {
  const selector = `article[data-testid="tweet"]:has(a[href*="/status/${postId}"])`;
  const locator = page.locator(selector).first();
  if ((await locator.count()) < 1) {
    return null;
  }

  const outputPath = path.join(postDir, 'tweet.png');
  await locator.screenshot({ path: outputPath });
  return outputPath;
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

async function collectPostSnapshot(page, source, postRef, config) {
  await page.goto(postRef.postUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.network.timeoutMs,
  });
  await sleep(config.collection.waitAfterNavigationMs);

  const extracted = await extractPostDataFromPage(page, source, postRef);
  if (!extracted) {
    throw new Error(`Failed to locate target tweet article for ${postRef.postUrl}`);
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
