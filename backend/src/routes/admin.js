const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { config } = require('../config');
const { User, Contact, Campaign, CampaignMessage, CampaignArchive, Usage } = require('../models');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah, idParam } = require('../utils/httpError');
const { pageParams, pageResult, escapeRegex } = require('../utils/pagination');
const { audit } = require('../utils/audit');
const { listAudit } = require('../utils/auditQuery');
const { getSettings, updateSettings, updateSchema: settingsSchema } = require('../utils/settings');
const { periodOf } = require('../services/usage');
const { passwordSchema, emailSchema } = require('./auth');
const { customersRouter } = require('./customersRouter');
const { attachCreditRoutes } = require('./creditRoutes');

const router = express.Router();

const resellerFields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: emailSchema,
  companyName: z.string().trim().max(160).default(''),
  phone: z.string().trim().max(40).default(''),
  maxCustomers: z.coerce.number().int().min(0).max(100000).default(50),
  allowQr: z.boolean().optional(),
};
const createReseller = z.object({ ...resellerFields, password: passwordSchema });
const updateReseller = z.object(resellerFields).partial().strict();

const resellers = express.Router();
resellers.param('id', idParam);

async function loadReseller(id) {
  const r = await User.findOne({ _id: id, role: 'reseller' });
  if (!r) throw new HttpError(404, 'Reseller not found');
  return r;
}

resellers.get(
  '/',
  ah(async (req, res) => {
    const filter = { role: 'reseller' };
    if (req.query.status === 'active' || req.query.status === 'suspended') filter.status = req.query.status;
    if (req.query.q) {
      const r = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), 'i');
      filter.$or = [{ name: r }, { email: r }, { companyName: r }];
    }
    const pp = pageParams(req.query);
    const [rows, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit), User.countDocuments(filter)]);
    const counts = await Promise.all(rows.map((r) => User.countDocuments({ role: 'customer', resellerId: r._id })));
    res.json(pageResult(rows.map((r, i) => ({ ...r.toJSON(), customerCount: counts[i] })), total, pp));
  }),
);

resellers.post(
  '/',
  validate(createReseller),
  ah(async (req, res) => {
    const b = req.body;
    const settings = await getSettings();
    const reseller = await User.create({
      role: 'reseller',
      name: b.name,
      email: b.email,
      companyName: b.companyName,
      phone: b.phone,
      maxCustomers: b.maxCustomers,
      allowQr: b.allowQr ?? settings.allowQrForNewUsers,
      passwordHash: await bcrypt.hash(b.password, config.BCRYPT_ROUNDS),
      createdBy: req.user._id,
    });
    await audit(req, 'reseller.create', { targetType: 'reseller', targetId: reseller._id, meta: { email: reseller.email } });
    res.status(201).json({ reseller });
  }),
);

resellers.get(
  '/:id',
  ah(async (req, res) => {
    const r = await loadReseller(req.params.id);
    const customers = await User.find({ role: 'customer', resellerId: r._id }).select('_id status');
    const ids = customers.map((c) => c._id);
    const usage = ids.length ? await Usage.aggregate([{ $match: { ownerId: { $in: ids }, period: periodOf() } }, { $group: { _id: null, messages: { $sum: '$messages' } } }]) : [];
    res.json({
      reseller: r,
      customerCount: customers.length,
      activeCustomers: customers.filter((c) => c.status === 'active').length,
      messagesThisMonth: usage[0] ? usage[0].messages : 0,
    });
  }),
);

resellers.patch(
  '/:id',
  validate(updateReseller),
  ah(async (req, res) => {
    const r = await loadReseller(req.params.id);
    const set = { ...req.body };
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
    if (set.maxCustomers !== undefined) {
      const current = await User.countDocuments({ role: 'customer', resellerId: r._id });
      if (set.maxCustomers < current) throw new HttpError(422, `Reseller already has ${current} customers; the limit cannot be lower than that.`);
    }
    const updated = await User.findOneAndUpdate({ _id: r._id }, { $set: set }, { new: true, runValidators: true });
    await audit(req, 'reseller.update', { targetType: 'reseller', targetId: r._id, meta: { fields: Object.keys(set) } });
    res.json({ reseller: updated });
  }),
);

resellers.post(
  '/:id/suspend',
  ah(async (req, res) => {
    const r = await loadReseller(req.params.id);
    const updated = await User.findOneAndUpdate({ _id: r._id }, { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } }, { new: true });
    await audit(req, 'reseller.suspend', { targetType: 'reseller', targetId: r._id });
    res.json({ reseller: updated });
  }),
);

resellers.post(
  '/:id/activate',
  ah(async (req, res) => {
    const r = await loadReseller(req.params.id);
    const updated = await User.findOneAndUpdate({ _id: r._id }, { $set: { status: 'active' } }, { new: true });
    await audit(req, 'reseller.activate', { targetType: 'reseller', targetId: r._id });
    res.json({ reseller: updated });
  }),
);

resellers.post(
  '/:id/reset-password',
  validate(z.object({ password: passwordSchema })),
  ah(async (req, res) => {
    const r = await loadReseller(req.params.id);
    await User.updateOne(
      { _id: r._id },
      { $set: { passwordHash: await bcrypt.hash(req.body.password, config.BCRYPT_ROUNDS), failedLogins: 0, lockUntil: null }, $inc: { tokenVersion: 1 } },
    );
    await audit(req, 'reseller.reset_password', { targetType: 'reseller', targetId: r._id });
    res.json({ ok: true });
  }),
);

attachCreditRoutes(resellers, (req) => loadReseller(req.params.id), 'reseller');

router.use('/resellers', resellers);
router.use('/voice', require('./voiceAdmin'));
router.use('/wa-api', require('./waApiAdmin'));
router.use('/customers', customersRouter({ role: 'admin' }));

router.get(
  '/stats',
  ah(async (req, res) => {
    const period = periodOf();
    const count = (role, status) => User.countDocuments({ role, status });
    const [rActive, rSusp, cActive, cSusp, contacts, campaignRows, archivedCampaignRows, usageRows, topUsage, recent] = await Promise.all([
      count('reseller', 'active'),
      count('reseller', 'suspended'),
      count('customer', 'active'),
      count('customer', 'suspended'),
      Contact.countDocuments({}),
      Campaign.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      CampaignArchive.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      Usage.aggregate([{ $match: { period } }, { $group: { _id: null, messages: { $sum: '$messages' }, simulated: { $sum: '$simulatedMessages' } } }]),
      Usage.find({ period }).sort({ messages: -1 }).limit(5).lean(),
      listAudit({}, { limit: 8 }),
    ]);
    const owners = await User.find({ _id: { $in: topUsage.map((u) => u.ownerId) } }).select('name email');
    const nameBy = Object.fromEntries(owners.map((o) => [String(o._id), o.name]));
    const campaigns = {};
    let totalCampaigns = 0;
    for (const r of campaignRows) {
      campaigns[r._id] = r.n;
      totalCampaigns += r.n;
    }
    for (const r of archivedCampaignRows) {
      campaigns[r._id] = (campaigns[r._id] || 0) + r.n;
      totalCampaigns += r.n;
    }
    const [failed, archivedFailures] = await Promise.all([
      CampaignMessage.countDocuments({ status: { $in: ['failed', 'simulated_failed'] } }),
      CampaignArchive.aggregate([
        { $unwind: '$messageBuckets' },
        { $match: { 'messageBuckets.status': { $in: ['failed', 'simulated_failed'] } } },
        { $group: { _id: null, count: { $sum: '$messageBuckets.count' } } },
      ]),
    ]);
    res.json({
      period,
      resellers: { active: rActive, suspended: rSusp },
      customers: { active: cActive, suspended: cSusp },
      contacts,
      campaigns: { total: totalCampaigns, byStatus: campaigns },
      messages: { thisMonth: usageRows[0]?.messages || 0, simulatedThisMonth: usageRows[0]?.simulated || 0, failedAllTime: failed + (archivedFailures[0]?.count || 0) },
      topCustomers: topUsage.map((u) => ({ ownerId: u.ownerId, name: nameBy[String(u.ownerId)] || 'Unknown', messages: u.messages })),
      recentActivity: recent.data,
    });
  }),
);

router.get('/audit', ah(async (req, res) => res.json(await listAudit({}, req.query))));

router.get('/settings', ah(async (req, res) => res.json({ settings: await getSettings(), env: { allowRealSend: config.ALLOW_REAL_SEND, defaultCountryCode: config.DEFAULT_COUNTRY_CODE, usageTimezone: config.USAGE_TIMEZONE } })));

router.put(
  '/settings',
  validate(settingsSchema),
  ah(async (req, res) => {
    if (!Object.keys(req.body).length) throw new HttpError(400, 'Nothing to update');
    const settings = await updateSettings(req.body);
    await audit(req, 'settings.update', { targetType: 'settings', meta: { fields: Object.keys(req.body) } });
    res.json({ settings });
  }),
);

module.exports = router;
