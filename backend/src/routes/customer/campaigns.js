const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { Campaign, CampaignMessage, Contact, Template } = require('../../models');
const { validate } = require('../../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../../utils/httpError');
const { pageParams, pageResult, escapeRegex } = require('../../utils/pagination');
const { toCSV } = require('../../utils/csv');
const { audit } = require('../../utils/audit');
const svc = require('../../services/campaignService');
const { removeFinishedCampaign } = require('../../services/campaignRetention');

const router = express.Router();
router.param('id', idParam);

const objectId = z.string().regex(OBJECT_ID_RE, 'Invalid id');
const group = z.string().trim().min(1).max(50);

const mapEntry = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('field'),
    field: z.string().regex(/^(name|first_name|phone|email|attr:[a-z0-9_]{1,30})$/, 'Unknown contact field'),
    fallback: z.string().trim().max(100).optional(),
  }),
  z.object({ source: z.literal('fixed'), value: z.string().trim().min(1, 'Value is required').max(200) }),
]);

const campaignBody = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(120),
  templateId: objectId,
  audience: z.object({
    mode: z.enum(['all', 'groups', 'contacts']),
    groups: z.array(group).max(50).default([]),
    contactIds: z.array(objectId).max(10000).default([]),
  }),
  variableMap: z.record(mapEntry).default({}),
  scheduledAt: z.coerce.date().nullable().optional(),
  submissionKey: z.string().trim().min(8).max(100).optional(),
});
const patchBody = campaignBody.omit({ submissionKey: true }).partial().strict();

const uniq = (a) => [...new Set(a)];

async function ensureRefs(ownerId, { templateId, audience }) {
  if (templateId && !(await Template.exists({ _id: templateId, ownerId }))) throw new HttpError(404, 'Template not found');
  if (audience && audience.mode === 'contacts' && audience.contactIds.length) {
    const ids = uniq(audience.contactIds);
    const n = await Contact.countDocuments({ ownerId, _id: { $in: ids } });
    if (n !== ids.length) throw new HttpError(400, 'Some selected contacts no longer exist', [{ field: 'audience.contactIds', message: 'Refresh the contact selection' }]);
  }
}

function normalizeAudience(a) {
  return { mode: a.mode, groups: a.mode === 'groups' ? uniq(a.groups) : [], contactIds: a.mode === 'contacts' ? uniq(a.contactIds) : [] };
}

const lowerKeys = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.toLowerCase(), v]));

async function load(req) {
  const c = await Campaign.findOne({ _id: req.params.id, ownerId: req.user._id });
  if (!c) throw new HttpError(404, 'This campaign was removed.');
  return c;
}

const brief = (s) => ({ recipients: s.recipients, excluded: s.excluded, queued: s.queued, sent: s.sent, delivered: s.delivered, read: s.read, failed: s.failed, cancelled: s.cancelled });

router.get(
  '/',
  ah(async (req, res) => {
    const filter = { ownerId: req.user._id };
    if (Campaign.CAMPAIGN_STATUSES.includes(req.query.status)) filter.status = req.query.status;
    if (req.query.channel === 'voice') filter.channel = 'voice';
    else if (req.query.channel === 'whatsapp') filter.channel = { $ne: 'voice' };
    if (req.query.q) filter.name = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), 'i');
    const pp = pageParams(req.query);
    const [rows, total] = await Promise.all([Campaign.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit), Campaign.countDocuments(filter)]);
    const stats = await Promise.all(rows.map((c) => svc.getCampaignStats(c._id)));
    res.json(pageResult(rows.map((c, i) => ({ ...c.toJSON(), stats: brief(stats[i]) })), total, pp));
  }),
);

router.post(
  '/',
  validate(campaignBody),
  ah(async (req, res) => {
    const b = req.body;
    const submissionKey = b.submissionKey || crypto.randomUUID();
    const existing = await Campaign.findOne({ ownerId: req.user._id, submissionKey });
    if (existing) return res.status(200).json({ campaign: existing, duplicate: true });
    await ensureRefs(req.user._id, b);
    let campaign;
    try {
      campaign = await Campaign.create({
        ownerId: req.user._id,
        name: b.name,
        templateId: b.templateId,
        audience: normalizeAudience(b.audience),
        variableMap: lowerKeys(b.variableMap),
        scheduledAt: b.scheduledAt || null,
        submissionKey,
        createdBy: req.user._id,
      });
    } catch (err) {
      if (err.code === 11000) {
        // two identical submissions raced: return the one that won
        const winner = await Campaign.findOne({ ownerId: req.user._id, submissionKey });
        if (winner) return res.status(200).json({ campaign: winner, duplicate: true });
      }
      throw err;
    }
    await audit(req, 'campaign.create', { targetType: 'campaign', targetId: campaign._id, ownerId: req.user._id, meta: { name: campaign.name } });
    return res.status(201).json({ campaign, duplicate: false });
  }),
);

router.get(
  '/:id',
  ah(async (req, res) => {
    const c = await load(req);
    res.json({ campaign: c, report: await svc.getCampaignReport(c) });
  }),
);

router.patch(
  '/:id',
  validate(patchBody),
  ah(async (req, res) => {
    const c = await load(req);
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, 'Only draft or scheduled campaigns can be edited.');
    const b = req.body;
    await ensureRefs(req.user._id, b);
    const set = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.templateId !== undefined) set.templateId = b.templateId;
    if (b.audience !== undefined) set.audience = normalizeAudience(b.audience);
    if (b.variableMap !== undefined) set.variableMap = lowerKeys(b.variableMap);
    if (b.scheduledAt !== undefined) set.scheduledAt = b.scheduledAt;
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
    const updated = await Campaign.findOneAndUpdate({ _id: c._id, ownerId: req.user._id, status: { $in: ['draft', 'scheduled'] } }, { $set: set }, { new: true });
    if (!updated) throw new HttpError(409, 'Campaign state changed; refresh and try again.');
    await audit(req, 'campaign.update', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id, meta: { fields: Object.keys(set) } });
    res.json({ campaign: updated });
  }),
);

router.post(
  '/:id/validate',
  ah(async (req, res) => {
    const c = await load(req);
    res.json(await svc.validateCampaign(c));
  }),
);

router.post(
  '/:id/schedule',
  validate(z.object({ scheduledAt: z.coerce.date() })),
  ah(async (req, res) => {
    const c = await load(req);
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, 'Only draft campaigns can be scheduled.');
    if (req.body.scheduledAt.getTime() <= Date.now() + 5000) throw new HttpError(400, 'Choose a time in the future', [{ field: 'scheduledAt', message: 'Must be in the future' }]);
    const report = await svc.validateCampaign(c);
    if (!report.ok) throw new HttpError(422, 'Campaign cannot be scheduled', { issues: report.issues });
    const updated = await Campaign.findOneAndUpdate(
      { _id: c._id, ownerId: req.user._id, status: { $in: ['draft', 'scheduled'] } },
      { $set: { status: 'scheduled', scheduledAt: req.body.scheduledAt, lastError: '' } },
      { new: true },
    );
    if (!updated) throw new HttpError(409, 'Campaign state changed; refresh and try again.');
    await audit(req, 'campaign.schedule', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id, meta: { scheduledAt: req.body.scheduledAt } });
    res.json({ campaign: updated });
  }),
);

router.post(
  '/:id/unschedule',
  ah(async (req, res) => {
    const c = await Campaign.findOneAndUpdate({ _id: req.params.id, ownerId: req.user._id, status: 'scheduled' }, { $set: { status: 'draft' } }, { new: true });
    if (!c) {
      if (!(await Campaign.exists({ _id: req.params.id, ownerId: req.user._id }))) throw new HttpError(404, 'Campaign not found');
      throw new HttpError(409, 'Only a scheduled campaign can be unscheduled.');
    }
    await audit(req, 'campaign.unschedule', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id });
    res.json({ campaign: c });
  }),
);

router.post(
  '/:id/start',
  ah(async (req, res) => {
    const c = await load(req);
    const started = await svc.startCampaign(c);
    await audit(req, 'campaign.start', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id, meta: { provider: started.provider, recipients: started.recipientCount } });
    res.json({ campaign: started });
  }),
);

router.post(
  '/:id/pause',
  ah(async (req, res) => {
    const c = await svc.pauseCampaign(req.params.id, req.user._id, 'Paused by user');
    await audit(req, 'campaign.pause', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id });
    res.json({ campaign: c });
  }),
);

router.post(
  '/:id/resume',
  ah(async (req, res) => {
    const c = await svc.resumeCampaign(req.params.id, req.user._id);
    await audit(req, 'campaign.resume', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id });
    res.json({ campaign: c });
  }),
);

router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { campaign, cancelledMessages } = await svc.cancelCampaign(req.params.id, req.user._id);
    await audit(req, 'campaign.cancel', { targetType: 'campaign', targetId: campaign._id, ownerId: req.user._id, meta: { cancelledMessages } });
    res.json({ campaign, cancelledMessages });
  }),
);

router.post(
  '/:id/clone',
  ah(async (req, res) => {
    const c = await load(req);
    const copy = await Campaign.create({
      ownerId: req.user._id,
      name: `Copy of ${c.name}`.slice(0, 120),
      channel: c.channel || 'whatsapp',
      templateId: c.channel === 'voice' ? undefined : c.templateId,
      templateName: c.channel === 'voice' ? 'Voice call' : undefined,
      voice: c.channel === 'voice' ? { cliNumberId: c.voice && c.voice.cliNumberId, audioMediaId: c.voice && c.voice.audioMediaId, text: (c.voice && c.voice.text) || '' } : undefined,
      audience: c.audience,
      variableMap: c.variableMap,
      submissionKey: crypto.randomUUID(),
      createdBy: req.user._id,
    });
    await audit(req, 'campaign.clone', { targetType: 'campaign', targetId: copy._id, ownerId: req.user._id, meta: { from: String(c._id) } });
    res.status(201).json({ campaign: copy });
  }),
);

router.delete(
  '/:id',
  ah(async (req, res) => {
    const c = await load(req);
    if (['queued', 'running', 'paused'].includes(c.status)) throw new HttpError(409, 'Cancel the campaign before deleting it.');
    if (['completed', 'cancelled', 'failed'].includes(c.status)) {
      await removeFinishedCampaign(c._id, req.user._id);
    } else {
      await CampaignMessage.deleteMany({ campaignId: c._id, ownerId: req.user._id });
      await Campaign.deleteOne({ _id: c._id, ownerId: req.user._id });
    }
    await audit(req, 'campaign.delete', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id, meta: { name: c.name } });
    res.json({ ok: true });
  }),
);

/* ---- per-recipient report ---- */
const STATUS_GROUPS = {
  queued: ['queued', 'sending'],
  sent: ['sent', 'simulated_sent'],
  delivered: ['delivered', 'simulated_delivered'],
  read: ['read', 'simulated_read'],
  failed: ['failed', 'simulated_failed'],
  excluded: ['excluded'],
  cancelled: ['cancelled'],
};

function messageFilter(campaign, q) {
  const f = { campaignId: campaign._id, ownerId: campaign.ownerId };
  if (STATUS_GROUPS[q.status]) f.status = { $in: STATUS_GROUPS[q.status] };
  if (q.q) {
    const r = new RegExp(escapeRegex(String(q.q).slice(0, 80)), 'i');
    f.$or = [{ phone: r }, { contactName: r }];
  }
  return f;
}

router.get(
  '/:id/messages',
  ah(async (req, res) => {
    const c = await load(req);
    const filter = messageFilter(c, req.query);
    const pp = pageParams(req.query, { defLimit: 25 });
    const [rows, total] = await Promise.all([
      CampaignMessage.find(filter).sort({ _id: 1 }).skip(pp.skip).limit(pp.limit).lean(),
      CampaignMessage.countDocuments(filter),
    ]);
    res.json(pageResult(rows, total, pp));
  }),
);

router.get(
  '/:id/export',
  ah(async (req, res) => {
    const c = await load(req);
    const rows = [['name', 'phone', 'status', 'simulated', 'excluded_reason', 'error', 'sent_at', 'delivered_at', 'read_at', 'failed_at', 'message']];
    for await (const m of CampaignMessage.find(messageFilter(c, req.query)).sort({ _id: 1 }).lean().cursor()) {
      const iso = (d) => (d ? new Date(d).toISOString() : '');
      rows.push([m.contactName, m.phone, m.status, m.simulated ? 'yes' : 'no', m.excludedReason, m.error, iso(m.sentAt), iso(m.deliveredAt), iso(m.readAt), iso(m.failedAt), m.text]);
    }
    await audit(req, 'campaign.export', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${String(c._id).slice(-6)}-report.csv"`);
    res.send(`\uFEFF${toCSV(rows)}`);
  }),
);

module.exports = router;
