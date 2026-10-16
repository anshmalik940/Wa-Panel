const crypto = require('crypto');
const { config } = require('../config');
const { ProviderError } = require('./errors');
const voice = require('../services/voiceService');

/**
 * Voice (calling) providers.
 *  voice_mock: simulated calls, free, never real. Numbers ending 0000 always fail.
 *  voice_http: calls any vendor's HTTP API described by the admin's templates (URL, headers, body, call-id path).
 * Not exercised against a live voice vendor from the development environment: test with one authorised number first.
 */
const mock = {
  name: 'voice_mock',
  simulated: true,
  async send({ message, settings }) {
    if (/0000$/.test(message.phone)) throw new ProviderError('Simulated failure: number is not reachable', { retryable: false, code: 'SIM_UNREACHABLE' });
    if (Math.random() * 100 < (settings.mockFailureRate || 0)) throw new ProviderError('Simulated random failure (admin mock failure rate)', { retryable: false, code: 'SIM_RANDOM' });
    return { providerMessageId: `mockcall.${crypto.randomUUID()}` };
  },
};

function requestValues({ message, campaign, cli }) {
  const media = message.media || {};
  return {
    to: String(message.phone).replace(/^\+/, ''),
    to_plus: message.phone,
    cli: String(cli || '').replace(/^\+/, ''),
    audio_url: media.url || '',
    text: message.text || '',
    name: message.contactName || '',
    message_id: String(message._id),
    campaign_id: String(campaign._id),
  };
}

/** Builds the HTTP request for one call (exported for tests and the admin "test call"). */
function buildRequest(cfg, values) {
  const apiKey = voice.apiKeyOf(cfg);
  const headers = voice.parseTemplate(cfg.headersTemplate || '{}', { ...values, apiKey });
  const body = voice.parseTemplate(cfg.bodyTemplate || '{}', values);
  let url = cfg.apiUrl;
  let payload;
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
  if (cfg.method === 'GET') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(body)) u.searchParams.set(k, String(v));
    url = u.toString();
  } else if (cfg.contentType === 'form') {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
  } else {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return { url, method: cfg.method, headers: h, body: payload };
}

async function callVendor(cfg, values) {
  const ready = voice.isReady(cfg);
  if (!ready.ok) throw new ProviderError(ready.problem, { code: 'VOICE_CONFIG' });
  let req;
  try {
    req = buildRequest(cfg, values);
  } catch (err) {
    throw new ProviderError(err.message, { code: 'VOICE_CONFIG' });
  }
  let res;
  try {
    res = await global.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new ProviderError(`Could not reach the voice API; call acceptance is unknown: ${err.message}`, { code: 'NETWORK' });
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch { /* vendor answered with plain text */ }
  if (!res.ok) {
    const reason = (json && (json.message || json.error || json.msg)) || text.slice(0, 200) || `HTTP ${res.status}`;
    const ambiguous = res.status >= 500;
    throw new ProviderError(`${ambiguous ? 'Call acceptance is unknown: ' : 'Voice API refused the call: '}${typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 200)}`, {
      code: res.status,
      status: res.status,
    });
  }
  if (cfg.successPath) {
    const got = json ? voice.getPath(json, cfg.successPath) : undefined;
    if (String(got) !== String(cfg.successValue)) {
      throw new ProviderError(`Voice API did not accept the call (${cfg.successPath} = ${got === undefined ? 'missing' : JSON.stringify(got)}, expected ${JSON.stringify(cfg.successValue)}).`, { code: 'VOICE_REJECTED' });
    }
  }
  const id = json && cfg.callIdPath ? voice.getPath(json, cfg.callIdPath) : undefined;
  return { providerMessageId: id === undefined || id === null ? '' : String(id), raw: json };
}

const http = {
  name: 'voice_http',
  simulated: false,
  async send({ message, campaign, voiceConfig, cliNumber }) {
    if (!config.ALLOW_REAL_SEND) throw new ProviderError('Real calling is disabled on this server (ALLOW_REAL_SEND=false).', { code: 'REAL_SEND_DISABLED' });
    const cli = cliNumber || (campaign.templateSnapshot && campaign.templateSnapshot.voice && campaign.templateSnapshot.voice.cliNumber) || '';
    return callVendor(voiceConfig, requestValues({ message, campaign, cli }));
  },
};

module.exports = { mock, http, buildRequest, callVendor, requestValues };
