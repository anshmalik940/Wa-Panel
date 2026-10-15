const express = require('express');
const { User, Usage } = require('../models');
const { asyncHandler: ah } = require('../utils/httpError');
const { listAudit } = require('../utils/auditQuery');
const { periodOf } = require('../services/usage');
const { customersRouter } = require('./customersRouter');

const router = express.Router();

router.use('/customers', customersRouter({ role: 'reseller' }));

router.get(
  '/stats',
  ah(async (req, res) => {
    const me = req.user;
    const customers = await User.find({ role: 'customer', resellerId: me._id }).select('name email status monthlyMessageLimit');
    const ids = customers.map((c) => c._id);
    const usage = ids.length ? await Usage.find({ ownerId: { $in: ids }, period: periodOf() }).lean() : [];
    const usageBy = Object.fromEntries(usage.map((u) => [String(u.ownerId), u]));
    const per = customers
      .map((c) => ({
        id: c._id,
        name: c.name,
        email: c.email,
        status: c.status,
        limit: c.monthlyMessageLimit,
        messages: usageBy[String(c._id)]?.messages || 0,
        simulated: usageBy[String(c._id)]?.simulatedMessages || 0,
      }))
      .sort((a, b) => b.messages - a.messages);
    res.json({
      period: periodOf(),
      customers: {
        total: customers.length,
        active: customers.filter((c) => c.status === 'active').length,
        suspended: customers.filter((c) => c.status === 'suspended').length,
        capacity: me.maxCustomers,
      },
      messagesThisMonth: per.reduce((a, c) => a + c.messages, 0),
      usagePerCustomer: per.slice(0, 10),
    });
  }),
);

router.get(
  '/audit',
  ah(async (req, res) => {
    const ids = (await User.find({ role: 'customer', resellerId: req.user._id }).select('_id')).map((c) => c._id);
    res.json(await listAudit({ $or: [{ actorId: req.user._id }, { ownerId: { $in: ids } }] }, req.query));
  }),
);

module.exports = router;
