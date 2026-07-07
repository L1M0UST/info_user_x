const crypto = require('crypto');
const { fetchJson } = require('./http');
const { normalizeWhitespace } = require('./utils');

const SEVERITY_LABELS = {
  info: 'INFO',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  critical: 'CRITICAL',
};

function resolveConfiguredValue(value, envName) {
  if (value) {
    return value;
  }

  if (envName && process.env[envName]) {
    return process.env[envName];
  }

  return '';
}

function compileRule(rule) {
  return {
    ...rule,
    regex: new RegExp(rule.pattern, rule.flags || 'i'),
  };
}

function buildAlertCorpus(snapshot, translation, source) {
  return [
    source.label,
    source.url,
    snapshot.postUrl,
    snapshot.text.original,
    translation?.translatedText || '',
    snapshot.links.map((link) => link.url).join('\n'),
  ].join('\n');
}

function matchRules(config, snapshot, translation, source) {
  const enabledRules = (config.alerts.rules || []).filter((rule) => rule.enabled !== false);
  const compiledRules = enabledRules.map(compileRule);
  const corpus = buildAlertCorpus(snapshot, translation, source);

  return compiledRules
    .filter((rule) => rule.regex.test(corpus))
    .map((rule) => ({
      ruleId: rule.id,
      label: rule.label,
      severity: rule.severity || 'info',
      pattern: rule.pattern,
      notifyChannels: Array.isArray(rule.notifyChannels) ? rule.notifyChannels : [],
      tags: Array.isArray(rule.tags) ? rule.tags : [],
    }));
}

function getAlertChannels(config) {
  const channels = config.alerts?.channels || {};
  return {
    telegram: {
      enabled: channels.telegram?.enabled !== false,
      botToken: resolveConfiguredValue(channels.telegram?.botToken, channels.telegram?.botTokenEnv),
      chatId: resolveConfiguredValue(channels.telegram?.chatId, channels.telegram?.chatIdEnv),
      disableWebPagePreview: channels.telegram?.disableWebPagePreview !== false,
      messageThreadId: resolveConfiguredValue(
        channels.telegram?.messageThreadId,
        channels.telegram?.messageThreadIdEnv
      ),
    },
    dingtalk: {
      enabled: channels.dingtalk?.enabled !== false,
      webhook: resolveConfiguredValue(channels.dingtalk?.webhook, channels.dingtalk?.webhookEnv),
      secret: resolveConfiguredValue(channels.dingtalk?.secret, channels.dingtalk?.secretEnv),
    },
  };
}

function buildDingTalkUrl(channelConfig) {
  const webhook = channelConfig.webhook || '';
  const secret = channelConfig.secret || '';
  if (!webhook) {
    return null;
  }

  if (!secret) {
    return webhook;
  }

  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(stringToSign)
    .digest('base64');
  const sign = encodeURIComponent(signature);
  const separator = webhook.includes('?') ? '&' : '?';
  return `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`;
}

async function sendDingTalkAlert(channelConfig, config, message) {
  if (!channelConfig.enabled) {
    return { skipped: true, reason: 'channel_disabled' };
  }

  const url = buildDingTalkUrl(channelConfig);
  if (!url) {
    return { skipped: true, reason: 'missing_webhook' };
  }

  return fetchJson(url, {
    method: 'POST',
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        title: message.title,
        text: message.text,
      },
      at: {
        isAtAll: false,
      },
    }),
  }, config.network.timeoutMs);
}

async function sendTelegramAlert(channelConfig, config, message) {
  if (!channelConfig.enabled) {
    return { skipped: true, reason: 'channel_disabled' };
  }

  if (!channelConfig.botToken) {
    return { skipped: true, reason: 'missing_bot_token' };
  }

  if (!channelConfig.chatId) {
    return { skipped: true, reason: 'missing_chat_id' };
  }

  const payload = {
    chat_id: channelConfig.chatId,
    text: message.text,
    disable_web_page_preview: channelConfig.disableWebPagePreview,
  };

  if (channelConfig.messageThreadId) {
    payload.message_thread_id = channelConfig.messageThreadId;
  }

  return fetchJson(`https://api.telegram.org/bot${channelConfig.botToken}/sendMessage`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }, config.network.timeoutMs);
}

function truncateText(text, limit = 420) {
  const normalized = normalizeWhitespace(text || '');
  if (!normalized) {
    return '(empty)';
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function buildAlertMessage(source, snapshot, translation, match, stored) {
  const severityLabel = SEVERITY_LABELS[match.severity] || String(match.severity || 'info').toUpperCase();
  const links = snapshot.links.map((item) => item.url).slice(0, 5);
  const lines = [
    'X alert triggered',
    `Severity: ${severityLabel}`,
    `Rule: ${match.label || match.ruleId} (${match.ruleId})`,
    `Source: ${source.label}`,
    `Source URL: ${source.url}`,
    `Post time: ${snapshot.createdAt || 'unknown'}`,
    `Post URL: ${snapshot.postUrl}`,
    `Canonical key: ${source.id}:${snapshot.postId}`,
  ];

  if (stored?.postDir) {
    lines.push(`Local archive: ${stored.postDir}`);
  }

  if (match.tags?.length) {
    lines.push(`Tags: ${match.tags.join(', ')}`);
  }

  lines.push('', 'Original:', truncateText(snapshot.text.original));

  if (translation?.translatedText) {
    lines.push('', 'Translated:', truncateText(translation.translatedText));
  }

  if (links.length) {
    lines.push('', 'Links:', ...links);
  }

  if (snapshot.media.hasVideo && snapshot.media.videoPostUrl) {
    lines.push('', `Video post URL: ${snapshot.media.videoPostUrl}`);
  }

  return {
    title: `[${severityLabel}] ${source.label} - ${match.label || match.ruleId}`,
    text: lines.join('\n'),
  };
}

async function sendAlertToChannel(channelName, channelConfig, config, message) {
  if (channelName === 'telegram') {
    return sendTelegramAlert(channelConfig, config, message);
  }

  if (channelName === 'dingtalk') {
    return sendDingTalkAlert(channelConfig, config, message);
  }

  return { skipped: true, reason: 'unknown_channel' };
}

function buildAlertRecord(baseRecord, channelName, match, message, response) {
  return {
    ...baseRecord,
    payload: {
      channel: channelName,
      match,
      message,
      response,
    },
  };
}

function normalizeChannelNames(names, channelMap) {
  const source = Array.isArray(names) && names.length ? names : Object.keys(channelMap);
  return [...new Set(
    source
      .map((name) => String(name || '').trim().toLowerCase())
      .filter((name) => name && channelMap[name])
  )];
}

function buildAlertResult(baseRecord, match, deliveryResults) {
  return {
    ...baseRecord,
    ruleId: match.ruleId,
    label: match.label,
    severity: match.severity,
    deliveredChannels: deliveryResults
      .filter((item) => item.status === 'sent')
      .map((item) => item.channel),
    skippedChannels: deliveryResults
      .filter((item) => item.status === 'skipped')
      .map((item) => item.channel),
    failedChannels: deliveryResults
      .filter((item) => item.status === 'failed')
      .map((item) => item.channel),
    deliveryResults,
  };
}

function createAlertDispatcher(config, storage, postgresStore) {
  const channelMap = getAlertChannels(config);

  return {
    async process(source, snapshot, translation, stored) {
      if (!config.alerts.enabled) {
        return [];
      }

      const matches = matchRules(config, snapshot, translation, source);
      if (!matches.length) {
        return [];
      }

      const processed = [];
      for (const match of matches) {
        const canonicalKey = `${source.id}:${snapshot.postId}`;
        const baseRecord = {
          canonicalKey,
          sourceId: source.id,
          postId: snapshot.postId,
          postUrl: snapshot.postUrl,
          sentAt: new Date().toISOString(),
        };
        const message = buildAlertMessage(source, snapshot, translation, match, stored);
        const channelNames = normalizeChannelNames(match.notifyChannels, channelMap);
        const deliveryResults = [];

        for (const channelName of channelNames) {
          const alertKey = `${canonicalKey}:${match.ruleId}:${channelName}`;
          if (await storage.hasAlert(alertKey)) {
            deliveryResults.push({
              channel: channelName,
              status: 'deduped',
            });
            continue;
          }

          try {
            const response = await sendAlertToChannel(channelName, channelMap[channelName], config, message);
            if (response?.skipped) {
              deliveryResults.push({
                channel: channelName,
                status: 'skipped',
                reason: response.reason,
              });
              continue;
            }

            const record = buildAlertRecord({
              ...baseRecord,
              alertKey,
              ruleId: match.ruleId,
            }, channelName, match, message, response);

            await storage.markAlertSent(record);
            if (postgresStore) {
              await postgresStore.saveAlert(record);
            }

            deliveryResults.push({
              channel: channelName,
              status: 'sent',
            });
          } catch (error) {
            deliveryResults.push({
              channel: channelName,
              status: 'failed',
              reason: error.message,
            });
          }
        }

        processed.push(buildAlertResult(baseRecord, match, deliveryResults));
      }

      return processed;
    },
  };
}

module.exports = {
  createAlertDispatcher,
};
