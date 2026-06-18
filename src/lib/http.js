const fs = require('fs');
const path = require('path');
const { ProxyAgent, fetch, setGlobalDispatcher } = require('undici');

let networkConfigured = false;

function configureNetwork(config) {
  if (networkConfigured) {
    return;
  }

  if (config.network.proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(config.network.proxyUrl));
    process.env.HTTP_PROXY = config.network.proxyUrl;
    process.env.HTTPS_PROXY = config.network.proxyUrl;
  }

  networkConfigured = true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadToFile(url, filePath, config) {
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      'user-agent': 'Mozilla/5.0',
    },
  }, config.network.downloadTimeoutMs);

  if (!response.ok) {
    throw new Error(`Failed to download asset: ${response.status} ${response.statusText} ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);

  return {
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    byteLength: buffer.length,
  };
}

async function fetchJson(url, options = {}, timeoutMs = 60000) {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  }, timeoutMs);

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

module.exports = {
  configureNetwork,
  downloadToFile,
  fetchJson,
};
