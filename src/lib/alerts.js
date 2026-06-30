const crypto = require('crypto');
const { fetchJson } = require('./http');

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
    }));
}

function buildDingTalkUrl(config) {
  const webhook = config.alerts?.dingtalk?.webhook || '';
  const secret = config.alerts?.dingtalk?.secret || '';
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

async function sendDingTalkAlert(config, message) {
  const url = buildDingTalkUrl(config);
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

function buildAlertMessage(source, snapshot, translation, matches) {
  const lines = [
    `### X 告警: ${source.label}`,
    ``,
    `- 规则: ${matches.map((item) => item.label || item.ruleId).join(', ')}`,
    `- 时间: ${snapshot.createdAt || 'unknown'}`,
    `- 链接: ${snapshot.postUrl}`,
    `- 原文:`,
    `${snapshot.text.original || '(empty)'}`,
  ];

  if (translation?.translatedText) {
    lines.push('', '- 译文:', translation.translatedText);
  }

  return {
    title: `X Alert - ${source.label}`,
    text: lines.join('\n'),
  };
}

function createAlertDispatcher(config, storage, postgresStore) {
  return {
    async process(source, snapshot, translation) {
      if (!config.alerts.enabled) {
        return [];
      }

      const matches = matchRules(config, snapshot, translation, source);
      if (!matches.length) {
        return [];
      }

      const sent = [];
      for (const match of matches) {
        const alertKey = `${source.id}:${snapshot.postId}:${match.ruleId}`;
        if (await storage.hasAlert(alertKey)) {
          continue;
        }

        const message = buildAlertMessage(source, snapshot, translation, [match]);
        const result = await sendDingTalkAlert(config, message);
        const record = {
          alertKey,
          canonicalKey: `${source.id}:${snapshot.postId}`,
          ruleId: match.ruleId,
          sourceId: source.id,
          postId: snapshot.postId,
          postUrl: snapshot.postUrl,
          sentAt: new Date().toISOString(),
          payload: {
            match,
            message,
            provider: 'dingtalk',
            response: result,
          },
        };

        await storage.markAlertSent(record);
        if (postgresStore) {
          await postgresStore.saveAlert(record);
        }

        sent.push(record);
      }

      return sent;
    },
  };
}

module.exports = {
  createAlertDispatcher,
};
