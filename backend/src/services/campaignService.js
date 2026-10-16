const mongoose = require('mongoose');
const { Campaign, CampaignMessage, Contact, Template, User, Media } = require('../models');
const { publicUrl } = require('../utils/media');
const { HttpError } = require('../utils/httpError');
const { render } = require('../utils/template');
const { config } = require('../config');
const { remainingQuota, incrementUsage } = require('./usage');
const { getSettings } = require('../utils/settings');
const voiceSvc = require('./voiceService');
const waApiSvc = require('./waApiService');
const { resolveWhatsApp, NOT_READY } = require('./providerResolver');
const { cleanupOwner } = require('./campaignRetention');
const { activeCutting, cutCountFor, seededRandom } = require('./cutting');

const oid = (id) => new mongoose.Types.ObjectId(String(id));
const MEDIA_TYPES = ['image', 'video', 'document'];

function attachmentTypeOf(template) {
  if (template.attachmentType !== undefined && template.attachmentType !== null) return template.attachmentType;
  return MEDIA_TYPES.includes(template.headerType) ? template.headerType : 'none';
}

/* ---------- recipients & personalisation ---------- */

function contactField(contact, field) {
  switch (field) {
    case 'name': return contact.name;
    case 'first_name': return String(contact.name || '').trim().split(/\s+/)[0] || '';
    case 'phone': return contact.phone;
    case 'email': return contact.email;
    default:
      if (String(field).startsWith('attr:')) return (contact.attributes || {})[String(field).slice(5)];
      return '';
  }
}

const cleanParam = (v) => String(v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();

/** Spoken text for voice campaigns: {{name}}, {{first_name}} and {{phone}} are filled from the contact. */
function renderVoiceText(body, contact) {
  return String(body || '').replace(/\{\{\s*(name|first_name|phone)\s*\}\}/gi, (_, f) => cleanParam(contactField(contact, f.toLowerCase()) || ''));
}

/** Decide whether a contact can receive the campaign and render their personalised message. */
function evaluateRecipient(contact, snapshot, variableMap) {
  if (contact.optedOut) return { ok: false, reason: 'opted_out' };
  if (!contact.phoneValid) return { ok: false, reason: 'invalid_phone' };
  const params = {};
  for (const v of snapshot.variables || []) {
    const m = (variableMap || {})[v];
    let value = '';
    if (m && m.source === 'fixed') value = m.value;
    else if (m && m.source === 'field') {
      value = contactField(contact, m.field);
      if (value === undefined || value === null || !String(value).trim()) value = m.fallback || '';
    }
    if (value === undefined || value === null || !String(value).trim()) return { ok: false, reason: `missing_variable:${v}` };
    params[v] = cleanParam(value);
  }
  const text = snapshot.voice ? renderVoiceText(snapshot.body, contact) : [snapshot.header, render(snapshot.body, params), snapshot.footer].filter(Boolean).join('\n\n');
  return { ok: true, params, text };
}

function audienceQuery(campaign) {
  const q = { ownerId: campaign.ownerId }; // tenant isolation: audience can never cross owners
  const a = campaign.audience || {};
  if (a.mode === 'groups') q.groups = { $in: a.groups || [] };
  else if (a.mode === 'contacts') q._id = { $in: a.contactIds || [] };
  return q;
}

const snapshotOf = (t, media = []) => {
  const items = (Array.isArray(media) ? media : media ? [media] : []).map((item) => ({
    id: String(item._id),
    kind: item.kind,
    mime: item.mime,
    name: item.originalName,
    url: publicUrl(item),
  }));
  return {
    language: t.language,
    category: t.category,
    header: t.header,
    headerType: t.headerType || (t.header ? 'text' : 'none'),
    attachmentType: attachmentTypeOf(t),
    media: items.length <= 1 ? items[0] || null : items,
    body: t.body,
    footer: t.footer,
    variables: t.variables,
  };
};

async function snapshotWithMedia(t) {
  const ids = [t.mediaId, ...(t.extraMediaIds || [])].filter(Boolean);
  const media = ids.length ? await Media.find({ _id: { $in: ids }, ownerId: t.ownerId }) : [];
  const byId = new Map(media.map((item) => [String(item._id), item]));
  const ordered = ids.map((id) => byId.get(String(id))).filter(Boolean);
  return { snapshot: snapshotOf(t, ordered), media: byId.get(String(t.mediaId)) || null, mediaItems: ordered };
}

async function analyzeAudience(campaign, snapshot) {
  const out = { audienceSize: 0, eligible: 0, excluded: {}, samples: [] };
  for await (const c of Contact.find(audienceQuery(campaign)).lean().cursor()) {
    out.audienceSize += 1;
    const ev = evaluateRecipient(c, snapshot, campaign.variableMap);
    if (ev.ok) {
      out.eligible += 1;
      if (out.samples.length < 3) out.samples.push({ name: c.name, phone: c.phone, text: ev.text });
    } else {
      const key = ev.reason.split(':')[0];
      out.excluded[key] = (out.excluded[key] || 0) + 1;
    }
  }
  return out;
}

/* ---------- validation ---------- */

async function validateCampaign(campaign) {
  if (campaign.channel === 'voice') return validateVoiceCampaign(campaign);
  const issues = [];
  const add = (code, message) => issues.push({ code, message });

  const owner = await User.findById(campaign.ownerId);
  if (!owner || owner.status !== 'active') add('account_suspended', 'Your account is suspended.');

  const template = await Template.findOne({ _id: campaign.templateId, ownerId: campaign.ownerId });
  if (!template) add('template_missing', 'The selected template no longer exists.');
  else if (template.status !== 'approved') add('template_not_approved', `Template "${template.name}" is ${template.status}. Only approved templates can be used in campaigns.`);

  const resolved = owner ? await resolveWhatsApp(owner) : null;
  if (resolved && resolved.providerName === 'mock' && !config.ALLOW_MOCK_CAMPAIGNS) {
    add('mock_provider_disabled', 'Mock campaigns are available only in development, test, or explicitly enabled demo environments.');
  }
  if (!resolved || !resolved.ready) {
    add('whatsapp_not_connected', NOT_READY);
  } else if (resolved.providerName !== 'mock' && !config.ALLOW_REAL_SEND) {
    add('real_sending_disabled', 'Real sending is switched off on this server (ALLOW_REAL_SEND=false).');
  }

  const a = campaign.audience || {};
  if (a.mode === 'groups' && !(a.groups || []).length) add('no_audience_selected', 'Select at least one contact group.');
  if (a.mode === 'contacts' && !(a.contactIds || []).length) add('no_audience_selected', 'Select at least one contact.');

  let summary = null;
  if (template) {
    const { snapshot, mediaItems } = await snapshotWithMedia(template);
    const attachedMedia = Array.isArray(snapshot.media) ? snapshot.media : snapshot.media ? [snapshot.media] : [];
    if (resolved && resolved.providerName === 'wa_http') {
      const unsupportedAttachment = !['none', 'image', 'document'].includes(snapshot.attachmentType);
      const mediaProblem = unsupportedAttachment
        ? waApiSvc.mediaError({ kind: snapshot.attachmentType })
        : waApiSvc.mediaError(snapshot.media);
      if (mediaProblem) add('wa_http_media_unsupported', mediaProblem);
      if (attachedMedia.some((item) => item.kind === 'document' && item.mime !== 'application/pdf')) {
        add('wa_http_pdf_required', 'The vendor HTTP connection supports PDF documents only. Replace this attachment with a PDF.');
      }
      if (attachedMedia.some((item) => ['image', 'document'].includes(item.kind) && waApiSvc.isLocalOrPrivateUrl(item.url))) add('wa_http_media_url_private', waApiSvc.localMediaError);
    } else if (resolved && resolved.providerName !== 'wa_http' && attachedMedia.length > 1) {
      add('multiple_media_unsupported', 'Only the vendor HTTP connection supports multiple attachments. Choose a single file for this connection.');
    }
    const expectedMediaIds = [template.mediaId, ...(template.extraMediaIds || [])].filter(Boolean);
    if (expectedMediaIds.length !== mediaItems.length) {
      add('media_missing', `The ${snapshot.attachmentType} attached to template "${template.name}" no longer exists. Edit the template and choose the file again.`);
    }
    let unmapped = false;
    for (const v of snapshot.variables) {
      const m = (campaign.variableMap || {})[v];
      const ok = m && ((m.source === 'fixed' && String(m.value || '').trim()) || (m.source === 'field' && m.field));
      if (!ok) {
        unmapped = true;
        add('unmapped_variable', `Placeholder {{${v}}} has no value. Map it to a contact field or enter a fixed value.`);
      }
    }
    summary = await analyzeAudience(campaign, snapshot);
    if (summary.eligible === 0 && !unmapped && !issues.some((i) => i.code === 'no_audience_selected')) {
      add('no_eligible_recipients', 'No eligible recipients: everyone in the audience is excluded (opted out, invalid number or missing personalisation data).');
    }
    if (owner) {
      const q = await remainingQuota(owner._id);
      if (summary.eligible > q.remaining) {
        add('monthly_limit_exceeded', `This campaign needs ${summary.eligible} messages but only ${q.remaining} remain of your monthly limit (${q.limit}).`);
      }
      // real sends cost credits; simulated (mock) sends are free
      if (resolved && resolved.providerName !== 'mock') {
        const settings = await getSettings();
        const units = resolved.provider.costUnits ? resolved.provider.costUnits({ media: snapshot.media }, settings) : 1;
        const cost = settings.creditsPerMessage * units;
        const need = cost * summary.eligible;
        if (need > (owner.credits || 0)) {
          add('insufficient_credits', `This campaign needs ${need} credits for all ${summary.eligible} eligible recipients, including any cut recipients, but your wallet has ${owner.credits || 0}. Ask your ${owner.role === 'reseller' ? 'administrator' : 'reseller or administrator'} to add credits.`);
        }
      }
    }
  }
  return { ok: issues.length === 0, issues, summary };
}


/* ---------- voice campaigns ---------- */

/** Everything a voice campaign freezes at start: CLI number, audio file and spoken text. */
async function voiceSnapshot(campaign) {
  const v = campaign.voice || {};
  const owner = await User.findById(campaign.ownerId);
  const cli = v.cliNumberId && owner ? await voiceSvc.cliAllowedFor(owner, v.cliNumberId) : null;
  const media = v.audioMediaId ? await Media.findOne({ _id: v.audioMediaId, ownerId: campaign.ownerId, kind: 'audio' }) : null;
  const snapshot = {
    language: '',
    category: '',
    header: '',
    headerType: 'none',
    media: media ? { id: String(media._id), kind: 'audio', mime: media.mime, name: media.originalName, url: publicUrl(media) } : null,
    body: v.text || '',
    footer: '',
    variables: [],
    voice: { cliNumber: cli ? cli.number : '', cliNumberId: cli ? String(cli._id) : '', hasAudio: Boolean(media), hasText: Boolean((v.text || '').trim()) },
  };
  return { snapshot, cli, media };
}

async function validateVoiceCampaign(campaign) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  const owner = await User.findById(campaign.ownerId);
  if (!owner || owner.status !== 'active') add('account_suspended', 'Your account is suspended.');

  const cfg = await voiceSvc.getConfig();
  if (cfg.mode === 'mock' && !config.ALLOW_MOCK_CAMPAIGNS) {
    add('mock_provider_disabled', 'Mock campaigns are available only in development, test, or explicitly enabled demo environments.');
  }
  const ready = voiceSvc.isReady(cfg);
  if (!ready.ok) add('voice_not_configured', `Voice calling is not configured: ${ready.problem} Ask your administrator.`);
  else if (cfg.mode === 'http' && !config.ALLOW_REAL_SEND) add('real_sending_disabled', 'Real calling is switched off on this server (ALLOW_REAL_SEND=false).');

  const { snapshot, cli, media } = await voiceSnapshot(campaign);
  if (!cli) add('cli_missing', 'Choose a caller ID (CLI) number that is active and available to you.');
  if (!snapshot.voice.hasAudio && !snapshot.voice.hasText) add('voice_content_missing', 'Add an audio file or the text to be spoken in the call.');
  if (campaign.voice && campaign.voice.audioMediaId && !media) add('media_missing', 'The selected audio file no longer exists. Choose it again.');

  const a = campaign.audience || {};
  if (a.mode === 'groups' && !(a.groups || []).length) add('no_audience_selected', 'Select at least one contact group.');
  if (a.mode === 'contacts' && !(a.contactIds || []).length) add('no_audience_selected', 'Select at least one contact.');

  const summary = await analyzeAudience(campaign, snapshot);
  if (summary.eligible === 0 && !issues.some((i) => i.code === 'no_audience_selected')) {
    add('no_eligible_recipients', 'No eligible recipients: everyone in the audience is excluded (opted out or invalid number).');
  }
  if (owner) {
    const q = await remainingQuota(owner._id);
    if (summary.eligible > q.remaining) add('monthly_limit_exceeded', `This campaign needs ${summary.eligible} calls but only ${q.remaining} remain of your monthly limit (${q.limit}).`);
    if (cfg.mode === 'http') {
      const cost = (await getSettings()).creditsPerCall;
      const need = cost * summary.eligible;
      if (need > (owner.credits || 0)) add('insufficient_credits', `This campaign needs ${need} credits for all ${summary.eligible} eligible calls, including any cut calls, but your wallet has ${owner.credits || 0}. Ask your ${owner.role === 'reseller' ? 'administrator' : 'reseller or administrator'} to add credits.`);
    }
  }
  return { ok: issues.length === 0, issues, summary };
}

/* ---------- start / materialise ---------- */

/**
 * Creates one CampaignMessage per contact (idempotent: unique index + upsert) and moves the
 * campaign from "queued" to "running". Safe to re-run after a crash.
 */
async function materialize(campaign) {
  const snapshot = campaign.templateSnapshot;
  const simulated = ['mock', 'voice_mock'].includes(campaign.provider);
  const cutTarget = simulated ? 0 : campaign.cutRecipientTarget || 0;
  const selectedCutIds = new Set();
  if (cutTarget > 0) {
    const random = seededRandom(String(campaign._id));
    let eligibleSeen = 0;
    const reservoir = [];
    for await (const contact of Contact.find(audienceQuery(campaign)).sort({ _id: 1 }).lean().cursor()) {
      if (!evaluateRecipient(contact, snapshot, campaign.variableMap).ok) continue;
      if (eligibleSeen < cutTarget) reservoir.push(String(contact._id));
      else {
        const candidate = Math.floor(random() * (eligibleSeen + 1));
        if (candidate < cutTarget) reservoir[candidate] = String(contact._id);
      }
      eligibleSeen += 1;
    }
    for (const id of reservoir) selectedCutIds.add(id);
  }
  let ops = [];
  const flush = async () => {
    if (ops.length) {
      await CampaignMessage.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  };
  for await (const c of Contact.find(audienceQuery(campaign)).sort({ _id: 1 }).lean().cursor()) {
    const ev = evaluateRecipient(c, snapshot, campaign.variableMap);
    const doc = { campaignId: campaign._id, ownerId: campaign.ownerId, contactId: c._id, phone: c.phone, contactName: c.name, simulated };
    if (ev.ok) {
      Object.assign(doc, {
        status: 'queued',
        isCut: selectedCutIds.has(String(c._id)),
        cuttingPercentage: selectedCutIds.has(String(c._id)) ? campaign.cuttingPercentage : 0,
        text: ev.text,
        params: ev.params,
        media: snapshot.media || null,
        mockWillRead: simulated && Number(c.phone.slice(-1)) < 6,
      });
    } else {
      Object.assign(doc, { status: 'excluded', excludedReason: ev.reason });
    }
    ops.push({ updateOne: { filter: { campaignId: campaign._id, contactId: c._id }, update: { $setOnInsert: doc }, upsert: true } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  const eligible = await CampaignMessage.countDocuments({ campaignId: campaign._id, status: { $ne: 'excluded' } });
  const now = new Date();
  await Campaign.updateOne(
    { _id: campaign._id, status: 'queued' },
    { $set: eligible > 0 ? { status: 'running', recipientCount: eligible } : { status: 'completed', recipientCount: 0, completedAt: now } },
  );
}

async function startCampaign(campaign) {
  const report = await validateCampaign(campaign);
  if (!report.ok) throw new HttpError(422, 'Campaign cannot be started', { issues: report.issues });

  let provider;
  let templateName;
  let templateSnapshot;
  if (campaign.channel === 'voice') {
    provider = voiceSvc.providerFor(await voiceSvc.getConfig());
    templateName = 'Voice call';
    templateSnapshot = (await voiceSnapshot(campaign)).snapshot;
  } else {
    const template = await Template.findOne({ _id: campaign.templateId, ownerId: campaign.ownerId });
    const owner = await User.findById(campaign.ownerId);
    const resolved = await resolveWhatsApp(owner);
    provider = resolved.providerName;
    templateName = template.name;
    templateSnapshot = (await snapshotWithMedia(template)).snapshot;
  }
  const cutting = ['mock', 'voice_mock'].includes(provider) ? null : await activeCutting(campaign.ownerId);
  const cuttingPercentage = cutting ? cutting.percentage : 0;

  // Atomic state transition: only ONE concurrent caller can win this, so recipients are queued exactly once.
  const claimed = await Campaign.findOneAndUpdate(
    { _id: campaign._id, ownerId: campaign.ownerId, status: { $in: ['draft', 'scheduled'] } },
    {
      $set: {
        status: 'queued',
        startedAt: new Date(),
        provider,
        templateName,
        templateSnapshot,
        cuttingPercentage,
        cutRecipientTarget: cutCountFor(report.summary.eligible, cuttingPercentage),
        lastError: '',
        pausedAt: null,
      },
    },
    { new: true },
  );
  if (!claimed) throw new HttpError(409, 'This campaign has already been started (or cannot be started in its current state).');

  await incrementUsage(claimed.ownerId, { campaigns: 1 });
  try {
    await materialize(claimed);
  } catch (err) {
    // Two callers raced past the claim: the unique (campaignId, contactId) index stopped the second one.
    if (err && (err.code === 11000 || (err.writeErrors || []).some((e) => e.code === 11000))) {
      throw new HttpError(409, 'This campaign has already been started (or cannot be started in its current state).');
    }
    throw err;
  }
  const started = await Campaign.findById(claimed._id);
  if (started && started.status === 'completed') await cleanupOwner(claimed.ownerId);
  return started;
}

/* ---------- lifecycle ---------- */

async function pauseCampaign(id, ownerId, reason = '') {
  const c = await Campaign.findOneAndUpdate(
    { _id: id, ownerId, status: 'running' },
    { $set: { status: 'paused', pausedAt: new Date(), lastError: reason } },
    { new: true },
  );
  if (!c) {
    if (!(await Campaign.exists({ _id: id, ownerId }))) throw new HttpError(404, 'Campaign not found');
    throw new HttpError(409, 'Only a running campaign can be paused.');
  }
  return c;
}

async function resumeCampaign(id, ownerId) {
  const campaign = await Campaign.findOne({ _id: id, ownerId });
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  if (campaign.status !== 'paused') throw new HttpError(409, 'Only a paused campaign can be resumed.');
  const issues = [];
  if (campaign.channel === 'voice') {
    const cfg = await voiceSvc.getConfig();
    const ready = voiceSvc.isReady(cfg);
    if (!ready.ok || voiceSvc.providerFor(cfg) !== campaign.provider) {
      issues.push({ code: 'voice_not_configured', message: ready.ok ? 'The voice provider was changed since this campaign started.' : `Voice calling is not configured: ${ready.problem}` });
    } else if (cfg.mode === 'http' && !config.ALLOW_REAL_SEND) {
      issues.push({ code: 'real_sending_disabled', message: 'Real calling is switched off on this server.' });
    }
  } else {
    const owner = await User.findById(ownerId);
    const resolved = owner ? await resolveWhatsApp(owner) : null;
    if (!resolved || !resolved.ready || resolved.providerName !== campaign.provider) {
      issues.push({ code: 'whatsapp_not_connected', message: NOT_READY });
    } else if (resolved.providerName !== 'mock' && !config.ALLOW_REAL_SEND) {
      issues.push({ code: 'real_sending_disabled', message: 'Real sending is switched off on this server.' });
    }
  }
  const q = await remainingQuota(ownerId);
  const queued = await CampaignMessage.countDocuments({ campaignId: campaign._id, status: 'queued' });
  if (queued > 0 && q.remaining <= 0) issues.push({ code: 'monthly_limit_exceeded', message: 'Monthly message limit reached. Ask your administrator/reseller to raise it.' });
  if (issues.length) throw new HttpError(422, 'Campaign cannot be resumed', { issues });

  const next = queued > 0 ? { status: 'running', pausedAt: null, lastError: '', nextBatchAt: null } : { status: 'completed', completedAt: new Date(), pausedAt: null, lastError: '', nextBatchAt: null };
  const c = await Campaign.findOneAndUpdate({ _id: id, ownerId, status: 'paused' }, { $set: next }, { new: true });
  if (!c) throw new HttpError(409, 'Campaign state changed; refresh and try again.');
  if (c.status === 'completed') await cleanupOwner(ownerId);
  return c;
}

async function cancelCampaign(id, ownerId) {
  const c = await Campaign.findOneAndUpdate(
    { _id: id, ownerId, status: { $in: ['scheduled', 'queued', 'running', 'paused'] } },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
    { new: true },
  );
  if (!c) {
    if (!(await Campaign.exists({ _id: id, ownerId }))) throw new HttpError(404, 'Campaign not found');
    throw new HttpError(409, 'Only scheduled, running or paused campaigns can be cancelled.');
  }
  // Stops all pending work. Messages already handed to the provider (sending/sent) are not recalled.
  const r = await CampaignMessage.updateMany({ campaignId: c._id, status: 'queued' }, { $set: { status: 'cancelled' } });
  await cleanupOwner(ownerId);
  return { campaign: c, cancelledMessages: r.modifiedCount };
}

/* ---------- reporting ---------- */

/** Turns a { status: count } map into the cumulative funnel used by reports and dashboards. */
function funnel(by) {
  let total = 0;
  for (const k of Object.keys(by)) total += by[k];
  const n = (...ks) => ks.reduce((a, k) => a + (by[k] || 0), 0);
  const read = n('read', 'simulated_read');
  const delivered = n('delivered', 'simulated_delivered') + read;
  const sent = n('sent', 'simulated_sent') + delivered;
  const failed = n('failed', 'simulated_failed');
  const excluded = n('excluded');
  return {
    total,
    excluded,
    recipients: total - excluded,
    queued: n('queued'),
    sending: n('sending'),
    cancelled: n('cancelled'),
    sent,
    delivered,
    read,
    failed,
    unknown: n('unknown'),
    cut: n('cut'),
    byStatus: by,
  };
}

async function statusCounts(match) {
  const rows = await CampaignMessage.aggregate([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = {};
  for (const r of rows) by[r._id] = r.n;
  return by;
}

async function getCampaignStats(campaignId, simulated) {
  const match = { campaignId: oid(campaignId) };
  if (simulated !== undefined) match.simulated = simulated;
  return funnel(await statusCounts(match));
}

async function getCampaignReport(campaign) {
  const simulated = ['mock', 'voice_mock'].includes(campaign.provider);
  const stats = await getCampaignStats(campaign._id, simulated);
  const breakdown = async (match, field) => {
    const rows = await CampaignMessage.aggregate([
      { $match: { campaignId: campaign._id, ...match } },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    return rows.map((r) => ({ reason: r._id, count: r.n }));
  };
  const [excludedReasons, failureReasons, unknownReasons, billingRows] = await Promise.all([
    breakdown({ status: 'excluded' }, 'excludedReason'),
    breakdown({ status: { $in: ['failed', 'simulated_failed'] } }, 'error'),
    breakdown({ status: 'unknown' }, 'error'),
    CampaignMessage.aggregate([
      { $match: { campaignId: campaign._id, ownerId: campaign.ownerId, simulated: false, status: { $in: ['sent', 'delivered', 'read', 'failed', 'unknown', 'cut'] }, 'billing.originalCharge': { $gt: 0 }, 'billing.finalCharge': { $exists: true }, 'billing.refunded': { $ne: true } } },
      { $group: { _id: null, messages: { $sum: 1 }, cutMessages: { $sum: { $cond: [{ $eq: ['$status', 'cut'] }, 1, 0] } }, originalCharge: { $sum: { $ifNull: ['$billing.originalCharge', 0] } }, finalCharge: { $sum: { $ifNull: ['$billing.finalCharge', 0] } } } },
    ]),
  ]);
  const totals = billingRows[0] || { messages: 0, cutMessages: 0, originalCharge: 0, finalCharge: 0 };
  return {
    stats,
    excludedReasons,
    failureReasons,
    unknownReasons,
    simulated,
    billing: { messages: totals.messages, cutMessages: totals.cutMessages, originalCharge: totals.originalCharge, finalCharge: totals.finalCharge },
  };
}

module.exports = {
  evaluateRecipient,
  analyzeAudience,
  validateCampaign,
  startCampaign,
  materialize,
  pauseCampaign,
  resumeCampaign,
  cancelCampaign,
  getCampaignStats,
  getCampaignReport,
  funnel,
  statusCounts,
  snapshotOf,
  voiceSnapshot,
  oid,
};
