const crypto = require('crypto');
const express = require('express');
const { z } = require('zod');
const { Campaign, Contact, Media } = require('../../models');
const { validate } = require('../../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../../utils/httpError');
const { audit } = require('../../utils/audit');
const { getSettings } = require('../../utils/settings');
const voice = require('../../services/voiceService');

/** Voice campaigns (calls). Start / pause / cancel / report reuse the /campaigns endpoints. Mounted at /api/c/voice. */
const router = express.Router();
router.param('id', idParam);

const objectId = z.string().regex(OBJECT_ID_RE, 'Invalid id');
const uniq = (a) => [...new Set(a)];

const body = z.object({
  name: z.string().trim().min(1, 'Campaign name is required').max(120),
  cliNumberId: objectId.nullable().optional(),
  audioMediaId: objectId.nullable().optional(),
  text: z.string().trim().max(1000).default(''),
  audience: z.object({
    mode: z.enum(['all', 'groups', 'contacts']),
    groups: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
    contactIds: z.array(objectId).max(10000).default([]),
  }),
  scheduledAt: z.coerce.date().nullable().optional(),
  submissionKey: z.string().trim().min(8).max(100).optional(),
});
const patchBody = body.omit({ submissionKey: true }).partial().strict();

const normalizeAudience = (a) => ({ mode: a.mode, groups: a.mode === 'groups' ? uniq(a.groups) : [], contactIds: a.mode === 'contacts' ? uniq(a.contactIds) : [] });

async function checkRefs(user, b) {
  if (b.cliNumberId && !(await voice.cliAllowedFor(user, b.cliNumberId))) {
    throw new HttpError(400, 'This caller ID is not available to you', [{ field: 'cliNumberId', message: 'Choose one of your caller IDs' }]);
  }
  if (b.audioMediaId && !(await Media.exists({ _id: b.audioMediaId, ownerId: user._id, kind: 'audio' }))) {
    throw new HttpError(400, 'The audio file was not found (upload an audio file first)', [{ field: 'audioMediaId', message: 'Audio file not found' }]);
  }
  if (b.audience && b.audience.mode === 'contacts' && b.audience.contactIds.length) {
    const ids = uniq(b.audience.contactIds);
    if ((await Contact.countDocuments({ ownerId: user._id, _id: { $in: ids } })) !== ids.length) {
      throw new HttpError(400, 'Some selected contacts no longer exist', [{ field: 'audience.contactIds', message: 'Refresh the contact selection' }]);
    }
  }
}

/** What the voice campaign form needs: provider state, price per call, usable CLI numbers. */
router.get(
  '/',
  ah(async (req, res) => {
    const cfg = await voice.getConfig();
    const ready = voice.isReady(cfg);
    const clis = await voice.availableClis(req.user);
    res.json({
      provider: { mode: cfg.mode, name: cfg.providerName, ready: ready.ok, problem: ready.problem || '', allowRealSend: require('../../config').config.ALLOW_REAL_SEND },
      creditsPerCall: (await getSettings()).creditsPerCall,
      clis: clis.map((c) => ({ id: c._id, number: c.number, label: c.label })),
    });
  }),
);

router.post(
  '/campaigns',
  validate(body),
  ah(async (req, res) => {
    const b = req.body;
    const submissionKey = b.submissionKey || crypto.randomUUID();
    const existing = await Campaign.findOne({ ownerId: req.user._id, submissionKey });
    if (existing) return res.status(200).json({ campaign: existing, duplicate: true });
    await checkRefs(req.user, b);
    try {
      const campaign = await Campaign.create({
        ownerId: req.user._id,
        channel: 'voice',
        name: b.name,
        templateName: 'Voice call',
        voice: { cliNumberId: b.cliNumberId || null, audioMediaId: b.audioMediaId || null, text: b.text },
        audience: normalizeAudience(b.audience),
        scheduledAt: b.scheduledAt || null,
        submissionKey,
        createdBy: req.user._id,
      });
      await audit(req, 'campaign.create', { targetType: 'campaign', targetId: campaign._id, ownerId: req.user._id, meta: { name: campaign.name, channel: 'voice' } });
      return res.status(201).json({ campaign, duplicate: false });
    } catch (err) {
      if (err.code === 11000) {
        const winner = await Campaign.findOne({ ownerId: req.user._id, submissionKey });
        if (winner) return res.status(200).json({ campaign: winner, duplicate: true });
      }
      throw err;
    }
  }),
);

router.patch(
  '/campaigns/:id',
  validate(patchBody),
  ah(async (req, res) => {
    const c = await Campaign.findOne({ _id: req.params.id, ownerId: req.user._id, channel: 'voice' });
    if (!c) throw new HttpError(404, 'Campaign not found');
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, 'Only draft or scheduled campaigns can be edited.');
    const b = req.body;
    await checkRefs(req.user, b);
    const set = {};
    if (b.name !== undefined) set.name = b.name;
    if (b.audience !== undefined) set.audience = normalizeAudience(b.audience);
    if (b.scheduledAt !== undefined) set.scheduledAt = b.scheduledAt;
    if (b.cliNumberId !== undefined) set['voice.cliNumberId'] = b.cliNumberId || null;
    if (b.audioMediaId !== undefined) set['voice.audioMediaId'] = b.audioMediaId || null;
    if (b.text !== undefined) set['voice.text'] = b.text;
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
    const updated = await Campaign.findOneAndUpdate({ _id: c._id, ownerId: req.user._id, status: { $in: ['draft', 'scheduled'] } }, { $set: set }, { new: true });
    if (!updated) throw new HttpError(409, 'Campaign state changed; refresh and try again.');
    await audit(req, 'campaign.update', { targetType: 'campaign', targetId: c._id, ownerId: req.user._id, meta: { fields: Object.keys(set) } });
    res.json({ campaign: updated });
  }),
);

module.exports = router;
