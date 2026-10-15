/**
 * Customer account management, shared by the admin panel (all customers) and the reseller panel
 * (only that reseller's customers). `scope(req)` returns the extra filter that confines the actor.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { config } = require('../config');
const { User, Contact, Campaign } = require('../models');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../utils/httpError');
const { pageParams, pageResult, escapeRegex } = require('../utils/pagination');
const { audit } = require('../utils/audit');
const { getSettings } = require('../utils/settings');
const { getUsage, periodOf } = require('../services/usage');
const { passwordSchema, emailSchema } = require('./auth');
const { attachCreditRoutes } = require('./creditRoutes');
const { Usage } = require('../models');

const objectId = z.string().regex(OBJECT_ID_RE, 'Invalid id');
const limitNum = z.coerce.number().int().min(0).max(10000000);

const baseFields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  email: emailSchema,
  companyName: z.string().trim().max(160).default(''),
  phone: z.string().trim().max(40).default(''),
  monthlyMessageLimit: limitNum.optional(),
  contactLimit: limitNum.optional(),
  allowQr: z.boolean().optional(),
  resellerId: objectId.nullable().optional(),
};
const createSchema = z.object({ ...baseFields, password: passwordSchema });
const updateSchema = z.object(baseFields).partial().strict();

function customersRouter({ role }) {
  const router = express.Router();
  router.param('id', idParam);
  const isAdmin = role === 'admin';
  const scope = (req) => (isAdmin ? {} : { resellerId: req.user._id });

  async function loadCustomer(req) {
    const c = await User.findOne({ _id: req.params.id, role: 'customer', ...scope(req) });
    if (!c) throw new HttpError(404, 'Customer not found');
    return c;
  }

  async function assertResellerCapacity(resellerId, excludeCustomerId) {
    const reseller = await User.findOne({ _id: resellerId, role: 'reseller' });
    if (!reseller) throw new HttpError(400, 'Reseller not found', [{ field: 'resellerId', message: 'Reseller not found' }]);
    if (reseller.status !== 'active') throw new HttpError(400, 'Customers cannot be assigned to a suspended reseller', [{ field: 'resellerId', message: 'Reseller is suspended' }]);
    const filter = { role: 'customer', resellerId: reseller._id };
    if (excludeCustomerId) filter._id = { $ne: excludeCustomerId };
    const count = await User.countDocuments(filter);
    if (count >= reseller.maxCustomers) throw new HttpError(422, `This reseller has reached the maximum of ${reseller.maxCustomers} customers`);
    return reseller;
  }

  router.get(
    '/',
    ah(async (req, res) => {
      const filter = { role: 'customer', ...scope(req) };
      const { q, status, resellerId } = req.query;
      if (status === 'active' || status === 'suspended') filter.status = status;
      if (isAdmin && resellerId) {
        if (resellerId === 'none') filter.resellerId = null;
        else if (OBJECT_ID_RE.test(String(resellerId))) filter.resellerId = resellerId;
      }
      if (q) {
        const r = new RegExp(escapeRegex(String(q).slice(0, 100)), 'i');
        filter.$or = [{ name: r }, { email: r }, { companyName: r }];
      }
      const pp = pageParams(req.query);
      const [rows, total] = await Promise.all([User.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit), User.countDocuments(filter)]);
      const ids = rows.map((r) => r._id);
      const resellerIds = [...new Set(rows.filter((r) => r.resellerId).map((r) => String(r.resellerId)))];
      const [usage, resellers] = await Promise.all([
        Usage.find({ ownerId: { $in: ids }, period: periodOf() }).lean(),
        resellerIds.length ? User.find({ _id: { $in: resellerIds } }).select('name email') : [],
      ]);
      const usageBy = Object.fromEntries(usage.map((u) => [String(u.ownerId), u.messages]));
      const resBy = Object.fromEntries(resellers.map((r) => [String(r._id), r.name]));
      const data = rows.map((r) => ({
        ...r.toJSON(),
        messagesThisMonth: usageBy[String(r._id)] || 0,
        resellerName: r.resellerId ? resBy[String(r.resellerId)] || null : null,
      }));
      res.json(pageResult(data, total, pp));
    }),
  );

  router.post(
    '/',
    validate(createSchema),
    ah(async (req, res) => {
      const body = req.body;
      if (!isAdmin && body.allowQr !== undefined) throw new HttpError(403, 'Only an administrator can change QR permission');
      let resellerId = null;
      if (isAdmin) {
        if (body.resellerId) {
          await assertResellerCapacity(body.resellerId);
          resellerId = body.resellerId;
        }
      } else {
        if (body.resellerId) throw new HttpError(403, 'Resellers cannot assign customers to other resellers');
        await assertResellerCapacity(req.user._id);
        resellerId = req.user._id;
      }
      const defaults = await getSettings();
      const customer = await User.create({
        role: 'customer',
        name: body.name,
        email: body.email,
        companyName: body.companyName,
        phone: body.phone,
        passwordHash: await bcrypt.hash(body.password, config.BCRYPT_ROUNDS),
        resellerId,
        monthlyMessageLimit: body.monthlyMessageLimit ?? defaults.defaultMonthlyMessageLimit,
        contactLimit: body.contactLimit ?? defaults.defaultContactLimit,
        allowQr: isAdmin ? body.allowQr ?? defaults.allowQrForNewUsers : defaults.allowQrForNewUsers,
        createdBy: req.user._id,
      });
      await audit(req, 'customer.create', { targetType: 'customer', targetId: customer._id, ownerId: customer._id, meta: { email: customer.email, resellerId } });
      res.status(201).json({ customer });
    }),
  );

  router.get(
    '/:id',
    ah(async (req, res) => {
      const c = await loadCustomer(req);
      const [usage, contacts, campaigns, reseller] = await Promise.all([
        getUsage(c._id),
        Contact.countDocuments({ ownerId: c._id }),
        Campaign.countDocuments({ ownerId: c._id }),
        c.resellerId ? User.findById(c.resellerId).select('name email') : null,
      ]);
      res.json({ customer: c, usage, counts: { contacts, campaigns }, reseller });
    }),
  );

  router.patch(
    '/:id',
    validate(updateSchema),
    ah(async (req, res) => {
      const c = await loadCustomer(req);
      const body = req.body;
      const set = {};
      if (!isAdmin && body.allowQr !== undefined) throw new HttpError(403, 'Only an administrator can change QR permission');
      for (const k of ['name', 'email', 'companyName', 'phone', 'monthlyMessageLimit', 'contactLimit', ...(isAdmin ? ['allowQr'] : [])]) {
        if (body[k] !== undefined) set[k] = body[k];
      }
      if (body.resellerId !== undefined) {
        if (!isAdmin) throw new HttpError(403, 'Only an administrator can reassign customers');
        if (body.resellerId === null) set.resellerId = null;
        else if (String(c.resellerId) !== body.resellerId) {
          await assertResellerCapacity(body.resellerId, c._id);
          set.resellerId = body.resellerId;
        }
      }
      if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
      const updated = await User.findOneAndUpdate({ _id: c._id }, { $set: set }, { new: true, runValidators: true });
      await audit(req, 'customer.update', { targetType: 'customer', targetId: c._id, ownerId: c._id, meta: { fields: Object.keys(set) } });
      res.json({ customer: updated });
    }),
  );

  router.post(
    '/:id/suspend',
    ah(async (req, res) => {
      const c = await loadCustomer(req);
      // bump tokenVersion: every active session of this customer stops working immediately
      const updated = await User.findOneAndUpdate({ _id: c._id }, { $set: { status: 'suspended' }, $inc: { tokenVersion: 1 } }, { new: true });
      const paused = await Campaign.updateMany(
        { ownerId: c._id, status: 'running' },
        { $set: { status: 'paused', pausedAt: new Date(), lastError: 'Account suspended' } },
      );
      await audit(req, 'customer.suspend', { targetType: 'customer', targetId: c._id, ownerId: c._id, meta: { pausedCampaigns: paused.modifiedCount } });
      res.json({ customer: updated, pausedCampaigns: paused.modifiedCount });
    }),
  );

  router.post(
    '/:id/activate',
    ah(async (req, res) => {
      const c = await loadCustomer(req);
      const updated = await User.findOneAndUpdate({ _id: c._id }, { $set: { status: 'active' } }, { new: true });
      await audit(req, 'customer.activate', { targetType: 'customer', targetId: c._id, ownerId: c._id });
      res.json({ customer: updated });
    }),
  );

  router.post(
    '/:id/reset-password',
    validate(z.object({ password: passwordSchema })),
    ah(async (req, res) => {
      const c = await loadCustomer(req);
      await User.updateOne(
        { _id: c._id },
        { $set: { passwordHash: await bcrypt.hash(req.body.password, config.BCRYPT_ROUNDS), failedLogins: 0, lockUntil: null }, $inc: { tokenVersion: 1 } },
      );
      await audit(req, 'customer.reset_password', { targetType: 'customer', targetId: c._id, ownerId: c._id });
      res.json({ ok: true });
    }),
  );

  attachCreditRoutes(router, loadCustomer, 'customer');

  return router;
}

module.exports = { customersRouter, objectId };
