const { VoiceConfig, CliNumber, CampaignMessage, User } = require('../models');
const { encrypt, decrypt, randomToken } = require('../utils/crypto');
const { HttpError } = require('../utils/httpError');
const { config } = require('../config');

/** The single platform voice configuration (created on first use, in safe "mock" mode). */
async function getConfig() {
  let c = await VoiceConfig.findOne({ key: 'default' });
  if (!c) {
    try {
      c = await VoiceConfig.create({ key: 'default', webhookToken: randomToken(20) });
    } catch (err) {
      if (err.code !== 11000) throw err;
      c = await VoiceConfig.findOne({ key: 'default' });
    }
  }
  return c;
}

/** What the admin screen may see: everything except the API key itself. */
function serializeConfig(c) {
  return {
    mode: c.mode,
    providerName: c.providerName,
    apiUrl: c.apiUrl,
    method: c.method,
    contentType: c.contentType,
    headersTemplate: c.headersTemplate,
    bodyTemplate: c.bodyTemplate,
    hasApiKey: Boolean(c.apiKeyEnc),
    callIdPath: c.callIdPath,
    successPath: c.successPath,
    successValue: c.successValue,
    webhookUrl: `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/webhooks/voice/${c.webhookToken}`,
    allowRealSend: config.ALLOW_REAL_SEND,
    ready: isReady(c).ok,
    readyProblem: isReady(c).problem || '',
  };
}

/** Is the provider usable for campaigns? mock always is; http needs a URL and valid templates. */
function isReady(c) {
  if (c.mode === 'mock') return { ok: true };
  if (!/^https?:\/\//i.test(c.apiUrl || '')) return { ok: false, problem: 'The voice API URL is not set (it must start with http:// or https://).' };
  if (!c.apiKeyEnc && /\{\{\s*apiKey\s*\}\}/.test(`${c.headersTemplate} ${c.bodyTemplate}`)) return { ok: false, problem: 'The voice API key is not set.' };
  try {
    parseTemplate(c.headersTemplate || '{}', {});
    parseTemplate(c.bodyTemplate || '{}', {});
  } catch (err) {
    return { ok: false, problem: err.message };
  }
  return { ok: true };
}

const apiKeyOf = (c) => (c.apiKeyEnc ? decrypt(c.apiKeyEnc) : '');
const providerFor = (c) => (c.mode === 'http' ? 'voice_http' : 'voice_mock');

/**
 * Fills {{placeholders}} in a JSON-object template. Values are JSON-escaped, so a quote or newline in a contact
 * name can never break (or inject into) the request body. Throws a readable error when the template is not valid JSON.
 */
function parseTemplate(text, values) {
  const filled = String(text || '{}').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (_, k) => {
    const v = values[k];
    return JSON.stringify(v === undefined || v === null ? '' : String(v)).slice(1, -1);
  });
  let obj;
  try {
    obj = JSON.parse(filled);
  } catch {
    throw new Error('A request template is not valid JSON. It must be an object like {"to": "{{to}}"}.');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('A request template must be a JSON object like {"to": "{{to}}"}.');
  return obj;
}

const getPath = (obj, path) => String(path || '').split('.').filter(Boolean).reduce((o, k) => (o === undefined || o === null ? undefined : o[k]), obj);

/** CLI numbers a user may use: active ones that are unassigned, assigned to them, or assigned to their reseller. */
async function availableClis(user) {
  const owners = [null, user._id];
  if (user.resellerId) owners.push(user.resellerId);
  return CliNumber.find({ status: 'active', assignedToId: { $in: owners } }).sort({ number: 1 });
}

async function cliAllowedFor(user, cliId) {
  const all = await availableClis(user);
  return all.find((c) => String(c._id) === String(cliId)) || null;
}

const VOICE_STATUS = {
  answered: 'delivered', completed: 'delivered', connected: 'delivered', delivered: 'delivered', picked: 'delivered',
  failed: 'failed', busy: 'failed', no_answer: 'failed', noanswer: 'failed', rejected: 'failed', unreachable: 'failed', cancelled: 'failed',
};
const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

/** Status callback from the voice vendor: { call_id | callId | id, status, duration?, reason? }. Never applies the same step twice. */
async function applyCallback(token, body) {
  const cfg = await VoiceConfig.findOne({ key: 'default' });
  if (!cfg || !token || token !== cfg.webhookToken) throw new HttpError(403, 'Invalid voice webhook token');
  const callId = String(body.call_id ?? body.callId ?? body.id ?? '');
  const raw = String(body.status ?? '').toLowerCase().replace(/[\s-]+/g, '_');
  const next = VOICE_STATUS[raw];
  if (!callId || !next) return { result: 'ignored' };
  const msg = await CampaignMessage.findOne({ providerMessageId: callId, simulated: false });
  if (!msg) return { result: 'ignored' };
  const owner = await User.findById(msg.ownerId).select('_id');
  if (!owner) return { result: 'ignored' };
  const current = msg.status;
  let set;
  if (next === 'failed') {
    if (current === 'failed' || RANK[current] >= RANK.delivered) return { result: 'ignored' };
    set = { status: 'failed', failedAt: new Date(), error: `Call ${raw.replace(/_/g, ' ')}${body.reason ? `: ${String(body.reason).slice(0, 200)}` : ''}` };
  } else {
    if (!(current in RANK) || RANK[current] >= RANK.delivered) return { result: 'ignored' };
    set = { status: 'delivered', deliveredAt: new Date() };
  }
  const r = await CampaignMessage.updateOne({ _id: msg._id, status: current }, { $set: set });
  return { result: r.modifiedCount ? 'applied' : 'ignored' };
}

module.exports = { getConfig, serializeConfig, isReady, apiKeyOf, providerFor, parseTemplate, getPath, availableClis, cliAllowedFor, applyCallback, encrypt };
