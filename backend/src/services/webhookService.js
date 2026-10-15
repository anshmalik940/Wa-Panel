const { WhatsAppAccount, WebhookEvent, CampaignMessage, Contact, Template, User } = require('../models');
const { HttpError } = require('../utils/httpError');
const { decrypt, hmacSha256Hex, safeEqual } = require('../utils/crypto');
const { normalizePhone } = require('../utils/phone');
const { config } = require('../config');
const waApi = require('./waApiService');
const { ownerForInbound } = require('./messageAttribution');
const { incrementUsage } = require('./usage');

const RANK = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };
const STOP_RE = /^\s*(stop|stop all|unsubscribe|opt ?out)\s*[.!]*\s*$/i;

/** GET verification handshake. Returns the challenge string or throws 403. */
async function verifyChallenge(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe' || !token || !challenge) throw new HttpError(400, 'Invalid verification request');
  const platform = await waApi.getConfig();
  if (platform.activeProvider === 'meta' && platform.meta.verifyTokenEnc) {
    try {
      if (safeEqual(decrypt(platform.meta.verifyTokenEnc), String(token))) return String(challenge);
    } catch {
      throw new HttpError(403, 'Verification token mismatch');
    }
  }
  const accounts = await WhatsAppAccount.find({ verifyToken: { $ne: '' } }).select('verifyToken');
  for (const account of accounts) {
    try {
      if (safeEqual(decrypt(account.verifyToken), String(token))) return String(challenge);
    } catch {
      if (safeEqual(account.verifyToken, String(token))) return String(challenge);
    }
  }
  throw new HttpError(403, 'Verification token mismatch');
}

function signatureValid(account, rawBody, header) {
  if (!account.appSecretEnc || !header) return false;
  const expected = `sha256=${hmacSha256Hex(decrypt(account.appSecretEnc), rawBody)}`;
  return safeEqual(expected, header);
}

/** Claims an event id. Returns false when this exact event was already processed (duplicate delivery). */
async function claimEvent(ownerId, eventId, type, summary) {
  try {
    await WebhookEvent.create({ eventId, ownerId, type, summary });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false;
    throw err;
  }
}

async function eventOwner(account, job) {
  if (String(account.ownerId) !== 'platform') return account.ownerId;
  if (job.type.startsWith('status.')) {
    const message = await CampaignMessage.findOne({ providerMessageId: job.messageId }).select('ownerId').lean();
    if (message) return message.ownerId;
  } else if (job.type === 'inbound') {
    const owner = await ownerForInbound(job.from);
    if (owner) return owner.ownerId;
  } else if (job.type === 'template.status') {
    const template = await Template.findOne({
      $or: [
        ...(job.templateName ? [{ providerTemplateName: job.templateName }] : []),
        ...(job.templateId ? [{ providerTemplateId: job.templateId }] : []),
      ],
    }).select('ownerId').lean();
    if (template) return template.ownerId;
  }
  const admin = await User.findOne({ role: 'admin' }).select('_id').lean();
  if (!admin) throw new HttpError(500, 'Platform webhook cannot be attributed because no administrator exists.');
  return admin._id;
}

async function applyStatus(account, st) {
  const filter = String(account.ownerId) === 'platform'
    ? { providerMessageId: String(st.id) }
    : { ownerId: account.ownerId, providerMessageId: String(st.id) };
  const msg = await CampaignMessage.findOne(filter);
  if (!msg) return 'ignored';
  const incoming = st.status;
  if (!['sent', 'delivered', 'read', 'failed'].includes(incoming)) return 'ignored';
  const current = msg.status.replace(/^simulated_/, '');
  const map = (s) => (msg.simulated ? `simulated_${s}` : s);
  const ts = st.timestamp ? new Date(Number(st.timestamp) * 1000) : new Date();

  let set;
  if (incoming === 'failed') {
    if (RANK[current] >= RANK.delivered || current === 'failed') return 'ignored';
    const e = (st.errors && st.errors[0]) || {};
    set = { status: map('failed'), failedAt: ts, error: e.message || e.title || 'Delivery failed' };
  } else {
    if (current === 'failed' || current === 'excluded' || current === 'cancelled' || !(incoming in RANK) || RANK[incoming] <= RANK[current]) return 'ignored';
    set = { status: map(incoming) };
    if (incoming === 'sent') set.sentAt = ts;
    if (incoming === 'delivered') set.deliveredAt = ts;
    if (incoming === 'read') {
      set.readAt = ts;
      if (!msg.deliveredAt) set.deliveredAt = ts;
    }
  }
  // compare-and-set on the status we read: a concurrent update can never be overwritten
  const r = await CampaignMessage.updateOne({ _id: msg._id, status: msg.status }, { $set: set });
  if (r.modifiedCount && incoming === 'failed') await incrementUsage(msg.ownerId, { failed: 1 });
  return r.modifiedCount ? 'applied' : 'ignored';
}

async function applyInbound(account, m) {
  const text = m.type === 'text' && m.text ? m.text.body : m.button ? m.button.text : '';
  if (!STOP_RE.test(text || '')) return 'ignored';
  const { phone } = normalizePhone(`+${String(m.from || '').replace(/\D/g, '')}`, config.DEFAULT_COUNTRY_CODE);
  if (String(account.ownerId) === 'platform') {
    let latest = await ownerForInbound(phone);
    if (!latest) {
      latest = await CampaignMessage.findOne({
        phone,
        simulated: false,
        status: { $in: ['sent', 'delivered', 'read'] },
      }).sort({ sentAt: -1 }).select('ownerId contactId').lean();
    }
    if (!latest) return 'ignored';
    const r = await Contact.updateOne(
      { _id: latest.contactId, ownerId: latest.ownerId, phone, optedOut: false },
      { $set: { optedOut: true, optedOutAt: new Date(), optOutSource: 'whatsapp_stop' } },
    );
    return r.modifiedCount ? 'applied' : 'ignored';
  }
  const r = await Contact.updateOne(
    { ownerId: account.ownerId, phone, optedOut: false },
    { $set: { optedOut: true, optedOutAt: new Date(), optOutSource: 'whatsapp_stop' } },
  );
  return r.modifiedCount ? 'applied' : 'ignored';
}

async function applyTemplateUpdate(account, v) {
  const event = String(v.event || '').toUpperCase();
  const status = { APPROVED: 'approved', REJECTED: 'rejected', PENDING: 'pending' }[event];
  if (!status) return 'ignored';
  const platform = String(account.ownerId) === 'platform';
  const filter = platform ? { $or: [] } : { ownerId: account.ownerId, $or: [] };
  if (v.message_template_id) filter.$or.push({ providerTemplateId: String(v.message_template_id) });
  if (v.message_template_name) {
    filter.$or.push(platform
      ? { providerTemplateName: String(v.message_template_name) }
      : { name: String(v.message_template_name), ...(v.message_template_language ? { language: String(v.message_template_language) } : {}) });
  }
  if (!filter.$or.length) return 'ignored';
  const r = await Template.updateOne(filter, {
    $set: { status, rejectionReason: status === 'rejected' ? String(v.reason || 'Rejected by WhatsApp') : '', syncSource: platform ? 'platform_meta' : 'meta', lastSyncedAt: new Date() },
  });
  return r.modifiedCount ? 'applied' : 'ignored';
}

/**
 * Processes a POST webhook. `rawBody` must be the exact bytes Meta signed.
 * Security: tenant events are attributed through their phone/WABA id; platform events use the one
 * platform phone/WABA. Every candidate must pass its own app-secret signature check.
 */
async function handleWebhook({ body, rawBody, signature }) {
  if (!body || body.object !== 'whatsapp_business_account') throw new HttpError(400, 'Unsupported webhook payload');
  const entries = Array.isArray(body.entry) ? body.entry : [];

  const phoneIds = new Set();
  const wabaIds = new Set();
  for (const e of entries) {
    if (e.id) wabaIds.add(String(e.id));
    for (const ch of e.changes || []) {
      const pid = ch && ch.value && ch.value.metadata && ch.value.metadata.phone_number_id;
      if (pid) phoneIds.add(String(pid));
    }
  }
  const legacyAccounts = await WhatsAppAccount.find({
    $or: [{ phoneNumberId: { $in: [...phoneIds] } }, { wabaId: { $in: [...wabaIds] } }],
  });
  const candidates = legacyAccounts.map((account) => ({ account, platform: false }));
  const platform = await waApi.getConfig();
  if (platform.activeProvider === 'meta' && (
    phoneIds.has(String(platform.meta.phoneNumberId))
    || wabaIds.has(String(platform.meta.wabaId))
  )) {
    candidates.push({ account: waApi.metaAccount(platform), platform: true });
  }
  const result = { applied: 0, ignored: 0, duplicates: 0, rejectedAccounts: 0 };
  if (!candidates.length) return { ...result, note: 'no matching account' };

  const verified = candidates.filter(({ account }) => signatureValid(account, rawBody, signature));
  if (!verified.length) throw new HttpError(401, 'Invalid or missing webhook signature');
  result.rejectedAccounts = candidates.length - verified.length;

  const accountFor = (entry, value) => {
    const pid = value && value.metadata && value.metadata.phone_number_id;
    const matches = verified.filter(({ account }) => (pid && account.phoneNumberId === String(pid)) || (!pid && account.wabaId === String(entry.id)));
    return matches.find((candidate) => candidate.platform) || matches[0];
  };

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const candidate = accountFor(entry, value);
      if (!candidate) {
        result.ignored += 1;
        continue;
      }
      const { account } = candidate;
      const jobs = [];
      if (change.field === 'messages') {
        for (const st of value.statuses || []) {
          jobs.push({ id: `status|${st.id}|${st.status}|${st.timestamp || ''}`, type: `status.${st.status}`, messageId: String(st.id), summary: `${st.status} ${st.id}`, run: () => applyStatus(account, st) });
        }
        for (const m of value.messages || []) {
          jobs.push({ id: `inbound|${m.id}`, type: 'inbound', from: String(m.from || ''), summary: `inbound ${m.type || ''} from ${m.from || ''}`, run: () => applyInbound(account, m) });
        }
      } else if (change.field === 'message_template_status_update') {
        jobs.push({
          id: `template|${value.message_template_id || value.message_template_name}|${value.event}|${entry.time || ''}`,
          type: 'template.status',
          templateName: String(value.message_template_name || ''),
          templateId: String(value.message_template_id || ''),
          summary: `template ${value.message_template_name || value.message_template_id} ${value.event}`,
          run: () => applyTemplateUpdate(account, value),
        });
      }
      for (const job of jobs) {
        const ownerId = await eventOwner(account, job);
        const fresh = await claimEvent(ownerId, job.id, job.type, job.summary);
        if (!fresh) {
          result.duplicates += 1;
          continue;
        }
        try {
          const outcome = await job.run();
          if (outcome === 'applied') result.applied += 1;
          else {
            result.ignored += 1;
            await WebhookEvent.updateOne({ eventId: job.id }, { $set: { outcome: 'ignored' } });
          }

        } catch (err) {
          // release the claim so the provider's retry can be processed
          await WebhookEvent.deleteOne({ eventId: job.id });
          throw err;
        }
      }
    }
  }
  return result;
}

/** Opt a contact out because they sent STOP (used by the linked-phone provider as well as the webhook). */
async function optOutByPhone(ownerId, digits, source = 'whatsapp_stop') {
  const { phone } = normalizePhone(`+${String(digits || '').replace(/\D/g, '')}`, config.DEFAULT_COUNTRY_CODE);
  const r = await Contact.updateOne({ ownerId, phone, optedOut: false }, { $set: { optedOut: true, optedOutAt: new Date(), optOutSource: source } });
  return r.modifiedCount ? 'applied' : 'ignored';
}

module.exports = { verifyChallenge, handleWebhook, applyStatus, optOutByPhone, STOP_RE };
