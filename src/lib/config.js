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
      removeThinkTags: true,
    },
    alerts: {
      enabled: true,
      channels: {
        telegram: {
          enabled: true,
          botToken: '',
          botTokenEnv: 'TELEGRAM_BOT_TOKEN',
          chatId: '',
          chatIdEnv: 'TELEGRAM_CHAT_ID',
          disableWebPagePreview: true,
          messageThreadId: '',
          messageThreadIdEnv: 'TELEGRAM_MESSAGE_THREAD_ID',
        },
        dingtalk: {
          enabled: true,
          webhook: '',
          webhookEnv: 'DINGTALK_WEBHOOK',
          secret: '',
          secretEnv: 'DINGTALK_SECRET',
        },
      },
      rules: [
        {
          id: 'china-related',
          label: 'China Related',
          enabled: true,
          severity: 'high',
          pattern: '(\\u4e2d\\u56fd|China|Chinese|CN\\b|\\u4e0a\\u6d77|\\u5317\\u4eac|\\u6df1\\u5733|\\u9999\\u6e2f|\\u53f0\\u6e7e|Shanghai|Beijing|Shenzhen|Hong\\s*Kong|Taiwan)',
          flags: 'i',
          tags: ['china'],
          notifyChannels: ['telegram', 'dingtalk'],
        },
        {
          id: 'chongqing-priority',
          label: 'Chongqing Priority',
          enabled: true,
          severity: 'critical',
          pattern: '(\\u91cd\\u5e86|\\u91cd\\u6176|Chongqing)',
          flags: 'i',
          tags: ['china', 'chongqing'],
          notifyChannels: ['telegram', 'dingtalk'],
        },
      ],
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
      ssl: false,
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

function normalizeAlertsConfig(alerts) {
  const channels = alerts?.channels || {};
  const legacyDingTalk = alerts?.dingtalk || {};

  return {
    ...alerts,
    channels: {
      telegram: {
        enabled: channels.telegram?.enabled !== false,
        botToken: channels.telegram?.botToken || '',
        botTokenEnv: channels.telegram?.botTokenEnv || 'TELEGRAM_BOT_TOKEN',
        chatId: channels.telegram?.chatId || '',
        chatIdEnv: channels.telegram?.chatIdEnv || 'TELEGRAM_CHAT_ID',
        disableWebPagePreview: channels.telegram?.disableWebPagePreview !== false,
        messageThreadId: channels.telegram?.messageThreadId || '',
        messageThreadIdEnv: channels.telegram?.messageThreadIdEnv || 'TELEGRAM_MESSAGE_THREAD_ID',
      },
      dingtalk: {
        enabled: channels.dingtalk?.enabled !== false,
        webhook: channels.dingtalk?.webhook || legacyDingTalk.webhook || '',
        webhookEnv: channels.dingtalk?.webhookEnv || 'DINGTALK_WEBHOOK',
        secret: channels.dingtalk?.secret || legacyDingTalk.secret || '',
        secretEnv: channels.dingtalk?.secretEnv || 'DINGTALK_SECRET',
      },
    },
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
    alerts: normalizeAlertsConfig(merged.alerts),
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
