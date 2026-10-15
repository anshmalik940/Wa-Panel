const { config } = require('../config');
const waApi = require('../services/waApiService');
const { ProviderError } = require('./errors');

const nextSendAt = new Map();

function providerError(message, options = {}) {
  return new ProviderError(message, options);
}

async function request(record, message) {
  const ready = waApi.isReady(record);
  if (!ready.ok) throw providerError(ready.problem, { code: 'WA_HTTP_CONFIG' });
  const mediaProblem = waApi.mediaError(message.media);
  if (mediaProblem) throw providerError(mediaProblem, { code: 'WA_HTTP_MEDIA_UNSUPPORTED' });

  let req;
  try {
    req = waApi.buildRequest(record, message);
  } catch (err) {
    throw providerError(err.message, { code: 'WA_HTTP_CONFIG' });
  }

  let response;
  try {
    response = await global.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    throw providerError(`Could not reach the WhatsApp vendor API: ${waApi.maskSecret(err.message, req.apiKey)}`, {
      retryable: timedOut,
      code: timedOut ? 'WA_HTTP_TIMEOUT' : 'WA_HTTP_NETWORK',
    });
  }

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Some vendors answer with plain text.
  }
  const body = waApi.safeResponseBody(text, json, req.apiKey);
  const result = { status: response.status, body, json };
  if (!response.ok) {
    const reason = json && (json.message || json.error || json.msg);
    const detail = typeof reason === 'string' ? waApi.maskSecret(reason, req.apiKey) : text;
    const err = providerError(`WhatsApp vendor API returned HTTP ${response.status}${detail ? `: ${waApi.maskSecret(detail, req.apiKey).slice(0, 500)}` : ''}`, {
      retryable: response.status >= 500,
      code: response.status,
      status: response.status,
    });
    err.response = { status: response.status, body };
    throw err;
  }
  if (record.successPath) {
    const got = json ? waApi.getPath(json, record.successPath) : undefined;
    if (String(got) !== String(record.successValue)) {
      const actual = got === undefined ? 'missing' : waApi.maskSecret(JSON.stringify(got), req.apiKey);
      const expected = waApi.maskSecret(JSON.stringify(record.successValue), req.apiKey);
      const err = providerError(`WhatsApp vendor did not accept the message (${record.successPath} = ${actual}, expected ${expected}).`, {
        code: 'WA_HTTP_REJECTED',
        status: response.status,
      });
      err.response = { status: response.status, body };
      throw err;
    }
  }
  const id = json && record.messageIdPath ? waApi.getPath(json, record.messageIdPath) : undefined;
  return { ...result, providerMessageId: id === undefined || id === null ? '' : String(id) };
}

const provider = {
  name: 'wa_http',
  simulated: false,
  paced: true,

  async checkConnection() {
    const record = await waApi.getConfig();
    const ready = waApi.isReady(record);
    if (!ready.ok) throw providerError(ready.problem, { code: 'WA_HTTP_CONFIG' });
    return { displayPhone: '', verifiedName: record.providerName || 'Company WhatsApp API' };
  },

  async listTemplates() {
    return [];
  },

  async submitTemplate() {
    return { providerTemplateId: '', status: 'APPROVED' };
  },

  canSend(account) {
    return Date.now() >= (nextSendAt.get(String(account.ownerId)) || 0);
  },

  scheduleNext(account, delayMs) {
    nextSendAt.set(String(account.ownerId), Date.now() + Math.max(500, Number(delayMs) || 0));
  },

  costUnits(message) {
    return Math.max(1, waApi.mediaItems(message.media).length);
  },

  async send({ account, message, settings }) {
    if (!config.ALLOW_REAL_SEND) throw providerError('Real WhatsApp sending is disabled on this server (ALLOW_REAL_SEND=false).', { code: 'REAL_SEND_DISABLED' });
    const record = await waApi.getConfig();
    try {
      const result = await request(record, { phone: message.phone, text: message.text, media: message.media });
      return { providerMessageId: result.providerMessageId };
    } finally {
      this.scheduleNext(account, settings.waHttpDelayMs);
    }
  },

  async testSend(record, message) {
    return request(record, message);
  },
};

module.exports = provider;
