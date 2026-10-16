const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const { CampaignCutting, User, AuditLog } = require('../models');
const { requireRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../utils/httpError');
const { pageParams, pageResult, escapeRegex } = require('../utils/pagination');
const { audit } = require('../utils/audit');

const router = express.Router();
router.use(requireRole('admin'));
router.param('userId', idParam);

const changeSchema = z.object({
  percentage: z.coerce.number().min(0.01).max(100).refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8, 'Use up to two decimal places'),
  startsAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable().optional(),
  active: z.boolean().default(true),
  internalReason: z.string().trim().max(500).default(''),
}).strict().refine((value) => !value.expiresAt || value.expiresAt > value.startsAt, {
  message: 'Expiry must be later than the start date',
  path: ['expiresAt'],
});

function adminCutting(cutting) {
  if (!cutting) return null;
  return {
    percentage: cutting.percentage,
    startsAt: cutting.startsAt,
    expiresAt: cutting.expiresAt,
    active: cutting.active,
    internalReason: cutting.internalReason,
    changedByName: cutting.changedByName,
    updatedAt: cutting.updatedAt,
  };
}

router.get('/', ah(async (req, res) => {
  const filter = { role: { $in: ['customer', 'reseller'] } };
  if (req.query.q) {
    const term = new RegExp(escapeRegex(String(req.query.q).slice(0, 100)), 'i');
    filter.$or = [{ name: term }, { email: term }, { companyName: term }];
  }
  if (req.query.role === 'customer' || req.query.role === 'reseller') filter.role = req.query.role;
  const pp = pageParams(req.query);
  const [users, total] = await Promise.all([
    User.find(filter).select('name email role companyName').sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit).lean(),
    User.countDocuments(filter),
  ]);
  const cuttings = users.length ? await CampaignCutting.find({ userId: { $in: users.map((user) => user._id) } }).lean() : [];
  const byUser = new Map(cuttings.map((cutting) => [String(cutting.userId), cutting]));
  res.json(pageResult(users.map((user) => ({
    ...user,
    cutting: adminCutting(byUser.get(String(user._id))),
  })), total, pp));
}));

router.get('/:userId/history', ah(async (req, res) => {
  if (!OBJECT_ID_RE.test(req.params.userId)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findOne({ _id: req.params.userId, role: { $in: ['customer', 'reseller'] } }).select('_id');
  if (!user) throw new HttpError(404, 'User not found');
  const pp = pageParams(req.query);
  const filter = { ownerId: user._id, action: { $in: ['cutting.create', 'cutting.update', 'cutting.revoke', 'cutting.applied'] } };
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit).select('actorEmail action meta createdAt').lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json(pageResult(rows, total, pp));
}));

router.put('/:userId', validate(changeSchema), ah(async (req, res) => {
  if (!OBJECT_ID_RE.test(req.params.userId)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findOne({ _id: req.params.userId, role: { $in: ['customer', 'reseller'] } }).select('_id');
  if (!user) throw new HttpError(404, 'User not found');
  const previous = await CampaignCutting.findOne({ userId: user._id }).lean();
  let changed;
  try {
    changed = await CampaignCutting.findOneAndUpdate(
      { userId: user._id },
      { $set: { ...req.body, expiresAt: req.body.expiresAt || null, ruleKey: crypto.randomUUID(), changedBy: req.user._id, changedByName: req.user.name } },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    if (err && err.code === 11000) throw new HttpError(409, 'Another cutting update was saved at the same time. Refresh and try again.');
    throw err;
  }
  const action = previous ? 'cutting.update' : 'cutting.create';
  await audit(req, action, {
    targetType: 'campaign_cutting',
    targetId: user._id,
    ownerId: user._id,
    meta: { before: previous ? adminCutting(previous) : null, after: adminCutting(changed) },
  });
  res.json({ cutting: adminCutting(changed) });
}));

router.post('/:userId/revoke', ah(async (req, res) => {
  if (!OBJECT_ID_RE.test(req.params.userId)) throw new HttpError(400, 'Invalid user id');
  const user = await User.findOne({ _id: req.params.userId, role: { $in: ['customer', 'reseller'] } }).select('_id');
  if (!user) throw new HttpError(404, 'User not found');
  const previous = await CampaignCutting.findOne({ userId: user._id }).lean();
  if (!previous) throw new HttpError(404, 'Cutting rule not found');
  if (!previous.active) return res.json({ cutting: adminCutting(previous) });
  const revoked = await CampaignCutting.findOneAndUpdate(
    { userId: user._id, active: true },
    { $set: { active: false, changedBy: req.user._id, changedByName: req.user.name } },
    { new: true },
  );
  if (!revoked) throw new HttpError(409, 'Cutting rule changed; refresh and try again.');
  await audit(req, 'cutting.revoke', {
    targetType: 'campaign_cutting',
    targetId: user._id,
    ownerId: user._id,
    meta: { before: adminCutting(previous), after: adminCutting(revoked) },
  });
  res.json({ cutting: adminCutting(revoked) });
}));

module.exports = router;
