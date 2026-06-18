const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeXUrl, parseXHandleFromUrl, sanitizeSlug } = require('./utils');

const projectRoot = path.resolve(__dirname, '..', '..');
const configPath = path.join(projectRoot, 'config.json');

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined ? override : base;
  }

  if (typeof base !== 'object' || base === null) {
    return override !== undefined ? override : base;
  }

  const output = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    output[key] = deepMerge(base[key], value);
  }
  return output;
}

function getDefaultBrowserConfig() {
  const isWindows = os.platform() === 'win32';
  return {
    engine: 'playwright',
    executablePath: isWindows ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '',
    channel: '',
    userDataDir: isWindows ? 'C:\\Users\\17162\\AppData\\Local\\Microsoft\\Edge\\User Data' : '',
    profileDirectory: 'Default',
    authStrategy: 'persistent_profile',
    storageStatePath: path.join(projectRoot, 'data', 'runtime', 'storage-state.json'),
    headless: false,
    locale: 'en-US',
    viewport: {
      width: 1440,
      height: 960,
    },
    launchArgs: [],
  };
}

function getDefaults() {
  return {
    browser: getDefaultBrowserConfig(),
    network: {
      proxyUrl: 'http://127.0.0.1:7890',
      timeoutMs: 60000,
      downloadTimeoutMs: 60000,
    },
    collection: {
      defaultPostsPerSource: 5,
      waitAfterNavigationMs: 4000,
      maxScrollRounds: 4,
      saveHtmlSnapshot: true,
      savePageSnapshot: true,
      saveScreenshot: true,
      downloadImages: true,
    },
    llm: {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'https://api.minimax.io/v1',
      apiKeyEnv: 'MINIMAX_API_KEY',
      model: 'MiniMax-M3',
      targetLanguage: 'zh-CN',
      timeoutMs: 45000,
      retries: 2,
      temperature: 0.1,
      maxCompletionTokens: 1200,
      useForExtractionFallback: true,
    },
    storage: {
      rootDir: path.join(projectRoot, 'data'),
      exportStorageStatePath: path.join(projectRoot, 'data', 'runtime', 'storage-state.json'),
      loginCheckPath: path.join(projectRoot, 'data', 'runs', 'login-check.json'),
    },
    database: {
      enabled: false,
      optional: true,
      host: '127.0.0.1',
      port: 5432,
      database: 'postgres',
      user: 'taishi',
      passwordEnv: 'PGPASSWORD',
      schema: 'info_user_x',
    },
    schedule: {
      enabled: true,
      windowsTaskName: 'InfoUserX-DailyCollector',
      time: '08:30',
      linuxCron: '30 8 * * *',
    },
    sources: [],
  };
}

function migrateLegacySources(rawConfig) {
  if (Array.isArray(rawConfig.sources)) {
    return rawConfig.sources;
  }

  if (!Array.isArray(rawConfig.authors)) {
    return [];
  }

  return rawConfig.authors.map((author) => ({
    id: author.handle,
    label: author.label || author.handle,
    enabled: author.enabled,
    url: author.url || author.profileUrl || `https://x.com/${author.handle}`,
    maxPosts: author.maxPosts,
  }));
}

function normalizeSource(source, index, config) {
  const normalizedUrl = normalizeXUrl(source.url);
  const handle = parseXHandleFromUrl(normalizedUrl);
  const baseId = source.id || handle || `source-${index + 1}`;
  const id = sanitizeSlug(baseId);

  return {
    id,
    label: source.label || handle || id,
    enabled: source.enabled !== false,
    url: normalizedUrl,
    handle,
    slug: sanitizeSlug(source.label || handle || id),
    maxPosts: source.maxPosts || config.collection.defaultPostsPerSource,
  };
}

function loadConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Copy config.example.json to config.json first.`);
  }

  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const merged = deepMerge(getDefaults(), rawConfig);
  const rawSources = migrateLegacySources(merged);
  const normalizedSources = rawSources.map((source, index) => normalizeSource(source, index, merged));
  const enabledSources = normalizedSources.filter((source) => source.enabled);

  return {
    ...merged,
    sources: normalizedSources,
    enabledSources,
    projectRoot,
    configPath,
  };
}

module.exports = {
  configPath,
  loadConfig,
  projectRoot,
};
