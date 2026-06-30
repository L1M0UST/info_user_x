const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeSlug(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'item';
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripThinkTags(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

function normalizeXUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.hostname === 'twitter.com' || url.hostname.endsWith('.twitter.com')) {
    url.hostname = 'x.com';
  }

  url.hash = '';
  const paramsToDrop = ['s', 't', 'mx'];
  for (const name of paramsToDrop) {
    url.searchParams.delete(name);
  }

  return url.toString().replace(/\/$/, '');
}

function parseXHandleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 1) {
      return null;
    }

    const reserved = new Set(['home', 'explore', 'notifications', 'messages', 'search', 'i']);
    return reserved.has(segments[0]) ? null : segments[0];
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  const trimmed = stripThinkTags(String(text || '').trim());
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fencedMatch ? fencedMatch[1].trim() : trimmed;

  const start = source.indexOf('{');
  if (start === -1) {
    throw new Error(`No JSON object found in response: ${trimmed}`);
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Unclosed JSON object in response: ${trimmed}`);
}

function rewriteTwitterMediaUrl(url) {
  return String(url || '').replace(/([?&])name=[^&]+/, '$1name=orig');
}

function safeExtensionFromUrl(fileUrl) {
  try {
    const pathname = new URL(fileUrl).pathname;
    return path.extname(pathname) || '';
  } catch {
    return '';
  }
}

function safeExtensionFromContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (value.includes('jpeg')) {
    return '.jpg';
  }
  if (value.includes('png')) {
    return '.png';
  }
  if (value.includes('gif')) {
    return '.gif';
  }
  if (value.includes('webp')) {
    return '.webp';
  }
  return '';
}

module.exports = {
  extractJsonObject,
  normalizeWhitespace,
  normalizeXUrl,
  parseXHandleFromUrl,
  rewriteTwitterMediaUrl,
  safeExtensionFromContentType,
  safeExtensionFromUrl,
  sanitizeSlug,
  sleep,
  stripThinkTags,
};
