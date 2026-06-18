const { fetchJson } = require('./http');
const { extractJsonObject, normalizeWhitespace, sleep } = require('./utils');

function getApiKey(config) {
  return process.env[config.llm.apiKeyEnv] || '';
}

function extractMessageContent(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .join('');
  }

  return '';
}

function validateTranslationResult(parsed, targetLanguage) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Translation result is not an object');
  }

  const translatedText = typeof parsed.translated_text === 'string'
    ? parsed.translated_text.trim()
    : '';
  const detectedLanguage = typeof parsed.detected_language === 'string'
    ? parsed.detected_language.trim()
    : 'unknown';

  if (!translatedText) {
    throw new Error('translated_text is empty');
  }

  return {
    detectedLanguage,
    translatedText,
    targetLanguage,
    notes: typeof parsed.notes === 'string' ? parsed.notes.trim() : '',
  };
}

async function runJsonTask(config, taskName, payload) {
  const apiKey = getApiKey(config);
  if (!config.llm.enabled || !apiKey) {
    return null;
  }

  const baseUrl = config.llm.baseUrl.replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const systemPrompt = [
    'You are a strict JSON generator.',
    'Output only valid JSON.',
    'Do not use markdown fences.',
    'Do not add explanations before or after JSON.',
  ].join(' ');

  const userPrompt = JSON.stringify({
    task: taskName,
    output_schema: {
      detected_language: 'string',
      translated_text: 'string',
      notes: 'string',
    },
    payload,
  });

  let lastError;
  for (let attempt = 0; attempt <= config.llm.retries; attempt += 1) {
    try {
      const response = await fetchJson(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.llm.model,
          temperature: config.llm.temperature,
          max_completion_tokens: config.llm.maxCompletionTokens,
          thinking: {
            type: 'disabled',
          },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      }, config.llm.timeoutMs);

      const content = extractMessageContent(response);
      const parsed = JSON.parse(extractJsonObject(content));
      return {
        parsed,
        rawText: content,
        model: config.llm.model,
      };
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }

  throw lastError;
}

async function translatePost(config, snapshot) {
  const originalText = normalizeWhitespace(snapshot.text.original);
  if (!originalText) {
    return {
      enabled: Boolean(config.llm.enabled),
      skipped: true,
      translatedText: '',
      detectedLanguage: 'unknown',
      targetLanguage: config.llm.targetLanguage,
      provider: config.llm.provider,
      model: config.llm.model,
    };
  }

  const result = await runJsonTask(config, 'translate_x_post', {
    target_language: config.llm.targetLanguage,
    post_text: originalText,
    links: snapshot.links.map((link) => link.url),
    notes: 'Keep URLs, usernames, hashtags, and codes unchanged when possible.',
  });

  if (!result) {
    return {
      enabled: false,
      skipped: true,
      translatedText: '',
      detectedLanguage: 'unknown',
      targetLanguage: config.llm.targetLanguage,
      provider: config.llm.provider,
      model: config.llm.model,
    };
  }

  const validated = validateTranslationResult(result.parsed, config.llm.targetLanguage);
  return {
    enabled: true,
    skipped: false,
    provider: config.llm.provider,
    model: result.model,
    rawResponseText: result.rawText,
    ...validated,
  };
}

module.exports = {
  runJsonTask,
  translatePost,
};
