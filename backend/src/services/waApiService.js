const net = require('net');
const { WhatsappApiConfig } = require('../models');
const { encrypt, decrypt } = require('../utils/crypto');
const { config } = require('../config');

const PRESET = {
  mode: 'http',
  providerName: 'sms4power (wtap)',
  baseUrl: 'http://api.wtap.sms4power.com/wapp/v2/api/send',
  method: 'GET',
  contentType: 'query',
  paramNames: { apikey: 'apikey', mobile: 'mobile', msg: 'msg', pdf: 'pdf', img1: 'img1', img2: 'img2', country: 'country' },
  country: 'IN',
  mobileFormat: 'national',
  defaultCaption: '',
  successPath: '',
  successValue: '',
  messageIdPath: '',
  mediaMapping: { image: 'img1', document: 'pdf' },
};

const isSecretParam = (name) => /^(?:api[_-]?key|apikey|access[_-]?token|token|secret|key)$/i.test(name);

async function getConfig() {
  let record = await WhatsappApiConfig.findOne({ key: 'default' });
  if (!record) {
    try {
      record = await WhatsappApiConfig.create({ key: 'default' });
    } catch (err) {
      if (err.code !== 11000) throw err;
      record = await WhatsappApiConfig.findOne({ key: 'default' });
    }
  }
  if (record.$isDefault('activeProvider')) {
    record.activeProvider = record.mode === 'http' && isReady(record).ok ? 'wa_http' : 'mock';
    await record.save();
  }
  return record;
}

function serializeConfig(record) {
  const ready = isReady(record);
  const meta = record.meta || {};
  return {
    activeProvider: record.activeProvider,
    mode: record.mode,
    providerName: record.providerName,
    baseUrl: safeBaseUrl(record.baseUrl),
    method: record.method,
    contentType: record.contentType,
    paramNames: record.paramNames.toObject ? record.paramNames.toObject() : record.paramNames,
    country: record.country,
    mobileFormat: record.mobileFormat,
    defaultCaption: record.defaultCaption,
    successPath: record.successPath,
    successValue: record.successValue,
    messageIdPath: record.messageIdPath,
    mediaMapping: record.mediaMapping.toObject ? record.mediaMapping.toObject() : record.mediaMapping,
    hasApiKey: Boolean(record.apiKeyEnc),
    ready: ready.ok,
    readyProblem: ready.problem || '',
    allowRealSend: config.ALLOW_REAL_SEND,
    meta: {
      phoneNumberId: meta.phoneNumberId || '',
      wabaId: meta.wabaId || '',
      appId: meta.appId || '',
      graphVersion: meta.graphVersion || config.WHATSAPP_GRAPH_VERSION,
      hasAccessToken: Boolean(meta.accessTokenEnc),
      hasAppSecret: Boolean(meta.appSecretEnc),
      hasVerifyToken: Boolean(meta.verifyTokenEnc),
      status: meta.status || 'not_configured',
      lastCheckedAt: meta.lastCheckedAt || null,
      lastError: meta.lastError || '',
      displayPhone: meta.displayPhone || '',
      verifiedName: meta.verifiedName || '',
    },
    metaReady: metaReady(record).ok,
    qrStatus: (() => {
      const { status, phone, name, lastError } = require('./waSession').getState('platform');
      return { status, phone, name, lastError };
    })(),
    qrHasSavedSession: require('./waSession').hasSavedSession('platform'),
  };
}

function metaReady(record) {
  const meta = record.meta || {};
  if (!meta.phoneNumberId || !meta.wabaId || !meta.accessTokenEnc) {
    return { ok: false, problem: 'Meta phone number ID, WABA ID and access token are required.' };
  }
  if (!meta.appSecretEnc || !meta.verifyTokenEnc) {
    return { ok: false, problem: 'Meta app secret and webhook verify token are required.' };
  }
  return { ok: true };
}

function metaAccount(record) {
  const meta = record.meta || {};
  return {
    ownerId: 'platform',
    provider: 'meta',
    status: meta.status,
    phoneNumberId: meta.phoneNumberId,
    wabaId: meta.wabaId,
    appId: meta.appId || '',
    accessTokenEnc: meta.accessTokenEnc,
    appSecretEnc: meta.appSecretEnc,
    graphVersion: meta.graphVersion || config.WHATSAPP_GRAPH_VERSION,
  };
}

function safeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    for (const name of [...url.searchParams.keys()]) {
      if (isSecretParam(name)) url.searchParams.set(name, '[REDACTED]');
    }
    return url.toString();
  } catch {
    return maskSecret(value || '', '');
  }
}

function isReady(record) {
  if (record.mode === 'off') return { ok: false, problem: 'The Company WhatsApp API is switched off. Ask your administrator to enable it.' };
  let url;
  try {
    url = new URL(record.baseUrl);
  } catch {
    return { ok: false, problem: 'Enter a valid vendor API URL starting with http:// or https://.' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return { ok: false, problem: 'The vendor API URL must be an http:// or https:// URL without embedded credentials.' };
  }
  if ([...url.searchParams.keys()].some(isSecretParam)) {
    return { ok: false, problem: 'Do not put the API key in the base URL. Use the encrypted API-key field.' };
  }
  if (!record.apiKeyEnc) return { ok: false, problem: 'The vendor API key is not set.' };
  if (!record.paramNames.apikey || !record.paramNames.mobile || !record.paramNames.msg) {
    return { ok: false, problem: 'Parameter names for API key, mobile and message are required.' };
  }
  if (record.successPath && !record.successValue) {
    return { ok: false, problem: 'Set the expected success value or leave both success fields empty.' };
  }
  return { ok: true };
}

function apiKeyOf(record) {
  try {
    return record.apiKeyEnc ? decrypt(record.apiKeyEnc) : '';
  } catch {
    throw new Error('The stored WhatsApp API key cannot be decrypted. Ask the administrator to save it again.');
  }
}

function maskSecret(text, secret) {
  let masked = String(text ?? '');
  if (secret) {
    for (const value of new Set([secret, encodeURIComponent(secret), new URLSearchParams([['k', secret]]).toString().slice(2)])) {
      if (value) masked = masked.split(value).join('[REDACTED]');
    }
  }
  return masked
    .replace(/([?&](?:api[_-]?key|apikey|access[_-]?token|token|secret|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:api[_-]?key|apikey|access[_-]?token|token|secret|key)["']?\s*[:=]\s*["']?)[^"'&,}\s]+/gi, '$1[REDACTED]');
}

function getPath(obj, path) {
  return String(path || '').split('.').filter(Boolean).reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), obj);
}

function formatMobile(phone, format, countryCode = config.DEFAULT_COUNTRY_CODE) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (format === 'national' && countryCode && digits.startsWith(countryCode) && digits.length > countryCode.length) {
    digits = digits.slice(countryCode.length);
  }
  return digits;
}

function mediaItems(media) {
  if (!media) return [];
  return (Array.isArray(media) ? media : [media]).filter(Boolean);
}

function mediaError(media) {
  const items = mediaItems(media);
  const images = items.filter((item) => item.kind === 'image').length;
  const documents = items.filter((item) => item.kind === 'document').length;
  if (items.some((item) => !['image', 'document'].includes(item.kind))) {
    return 'This provider does not support video or audio attachments. Remove unsupported media.';
  }
  if (images > 2 || documents > 1 || items.length > 3) {
    return 'This provider supports at most two images and one PDF per message.';
  }
  return '';
}

function buildParams(record, { phone, text, media }, apiKey) {
  const names = record.paramNames;
  const hasMedia = mediaItems(media).length > 0;
  const messageText = String(text || '').trim() ? text : (hasMedia ? record.defaultCaption || '' : '');
  const values = [
    [names.apikey, apiKey],
    [names.mobile, formatMobile(phone, record.mobileFormat)],
    [names.msg, messageText],
    [names.country, record.country || ''],
  ].filter(([name]) => name);

  let imageIndex = 0;
  for (const item of mediaItems(media)) {
    if (item.kind === 'image') {
      const configured = imageIndex === 0 ? record.mediaMapping.image : names.img2;
      const otherImageKey = configured === 'img1' ? 'img2' : 'img1';
      const name = imageIndex === 0 ? (names[configured] || configured) : names[otherImageKey] || names.img2;
      values.push([name, item.url]);
      imageIndex += 1;
    } else if (item.kind === 'document') {
      const configured = record.mediaMapping.document;
      values.push([names[configured] || configured, item.url]);
    }
  }
  return values;
}

function buildRequest(record, message) {
  const apiKey = apiKeyOf(record);
  const params = buildParams(record, message, apiKey);
  const url = new URL(record.baseUrl);
  const method = record.method;
  let body;
  const headers = {};

  if (method === 'GET' || record.contentType === 'query') {
    for (const [name, value] of params) url.searchParams.set(name, String(value));
  } else if (record.contentType === 'json') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(Object.fromEntries(params));
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(params.map(([name, value]) => [name, String(value)])).toString();
  }

  return { url: url.toString(), method, headers, body, apiKey };
}

function safeResponseBody(text, json, apiKey) {
  const safeText = maskSecret(text, apiKey).slice(0, 2000);
  if (!json) return safeText;
  return JSON.parse(maskSecret(JSON.stringify(json), apiKey));
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || parts[0] === 0;
}

function isLocalOrPrivateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const version = net.isIP(host);
  if (version === 4) return isPrivateIpv4(host);
  if (version === 6) {
    const lower = host.toLowerCase();
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
      const hex = mapped.match(/^([a-f\d]{1,4}):([a-f\d]{1,4})$/);
      if (hex) {
        const high = Number.parseInt(hex[1], 16);
        const low = Number.parseInt(hex[2], 16);
        return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('::ffff:127.');
  }
  return false;
}

const localMediaError = 'The vendor cannot download media from a local address. Set PUBLIC_API_URL to a public https URL (or use a tunnel) or send without media.';

module.exports = {
  PRESET,
  getConfig,
  serializeConfig,
  safeBaseUrl,
  isReady,
  metaReady,
  metaAccount,
  apiKeyOf,
  encrypt,
  maskSecret,
  getPath,
  formatMobile,
  mediaItems,
  mediaError,
  buildParams,
  buildRequest,
  safeResponseBody,
  isLocalOrPrivateUrl,
  localMediaError,
};
