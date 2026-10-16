const express = require('express');
const { Contact, Template, Campaign, CampaignMessage, CampaignArchive, Usage, MonthlyUsageSummary, CreditTransaction } = require('../../models');
const { HttpError, asyncHandler: ah } = require('../../utils/httpError');
const { listAudit } = require('../../utils/auditQuery');
const { getUsage, periodOf, shiftPeriod, periodBounds, finalizePreviousMonth, limitsOf } = require('../../services/usage');
const { funnel, statusCounts } = require('../../services/campaignService');
const { User } = require('../../models');
const { validate } = require('../../middleware/validate');
const { z } = require('zod');
const { audit } = require('../../utils/audit');
const { pageParams, pageResult } = require('../../utils/pagination');
const { listLedger } = require('../../services/credits');
const { getSettings } = require('../../utils/settings');
const { config } = require('../../config');
const { resolveWhatsApp } = require('../../services/providerResolver');

const router = express.Router();

router.get(
  '/dashboard',
  ah(async (req, res) => {
    const ownerId = req.user._id;
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [total, valid, invalid, optedOut, tplRows, campRows, archivedCampRows, recent, msgBy, archivedMsgRows, usage, whatsapp] = await Promise.all([
      Contact.countDocuments({ ownerId }),
      Contact.countDocuments({ ownerId, phoneValid: true, optedOut: false }),
      Contact.countDocuments({ ownerId, phoneValid: false }),
      Contact.countDocuments({ ownerId, optedOut: true }),
      Template.aggregate([{ $match: { ownerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Campaign.aggregate([{ $match: { ownerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      CampaignArchive.aggregate([{ $match: { ownerId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
      Campaign.find({ ownerId }).sort({ createdAt: -1 }).limit(5),
      statusCounts({ ownerId, createdAt: { $gte: since } }),
      CampaignArchive.aggregate([
        { $match: { ownerId, 'messageBuckets.at': { $gte: since } } },
        { $unwind: '$messageBuckets' },
        { $match: { 'messageBuckets.at': { $gte: since } } },
        { $group: { _id: '$messageBuckets.status', n: { $sum: '$messageBuckets.count' } } },
      ]),
      getUsage(ownerId),
      resolveWhatsApp(req.user),
    ]);
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, r.n]));
    const campaignCounts = toMap(campRows);
    for (const row of archivedCampRows) campaignCounts[row._id] = (campaignCounts[row._id] || 0) + row.n;
    const messageCounts = { ...msgBy };
    for (const row of archivedMsgRows) messageCounts[row._id] = (messageCounts[row._id] || 0) + row.n;
    const recentRows = recent.length
      ? await CampaignMessage.aggregate([
        { $match: { campaignId: { $in: recent.map((campaign) => campaign._id) } } },
        { $group: { _id: { campaignId: '$campaignId', status: '$status' }, n: { $sum: 1 } } },
      ])
      : [];
    const recentCounts = new Map(recent.map((campaign) => [String(campaign._id), {}]));
    for (const row of recentRows) {
      const counts = recentCounts.get(String(row._id.campaignId));
      counts[row._id.status] = row.n;
    }
    const recentStats = recent.map((campaign) => funnel(recentCounts.get(String(campaign._id))));
    const f = funnel(messageCounts);
    res.json({
      contacts: { total, valid, invalid, optedOut },
      templates: toMap(tplRows),
      campaigns: campaignCounts,
      messagesLast30Days: { recipients: f.recipients, sent: f.sent, delivered: f.delivered, read: f.read, failed: f.failed, excluded: f.excluded, queued: f.queued },
      usage: { ...usage, limit: limitsOf(req.user).messages, remaining: Math.max(0, limitsOf(req.user).messages - usage.messages) },
      credits: req.user.credits || 0,
      whatsapp: {
        status: whatsapp.ready ? 'connected' : 'not_connected',
        provider: whatsapp.providerName,
        source: whatsapp.source,
      },
      recentCampaigns: recent.map((c, i) => ({ id: c._id, name: c.name, status: c.status, createdAt: c.createdAt, provider: c.provider, sent: recentStats[i].sent, recipients: recentStats[i].recipients, failed: recentStats[i].failed })),
    });
  }),
);

router.get(
  '/usage',
  ah(async (req, res) => {
    const ownerId = req.user._id;
    const currentPeriod = periodOf();
    const selectedPeriod = req.query.period === undefined ? currentPeriod : String(req.query.period);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedPeriod)) throw new HttpError(400, 'Invalid period. Use YYYY-MM.');
    if (selectedPeriod > currentPeriod) throw new HttpError(400, 'Future usage periods are not available.');
    const firstPeriod = shiftPeriod(currentPeriod, -11);
    const { start } = periodBounds(firstPeriod);
    const [usagePeriods, summaryPeriods, ledgerDates, selected, contacts, summary] = await Promise.all([
      Usage.find({ ownerId, period: { $gte: firstPeriod, $lte: currentPeriod } }).distinct('period'),
      MonthlyUsageSummary.find({ ownerId, period: { $gte: firstPeriod, $lte: currentPeriod } }).distinct('period'),
      CreditTransaction.find({ userId: ownerId, reason: { $in: ['campaign', 'refund'] }, createdAt: { $gte: start } }).select('createdAt').lean(),
      getUsage(ownerId, selectedPeriod),
      Contact.countDocuments({ ownerId }),
      finalizePreviousMonth(ownerId),
    ]);
    const periods = new Set([currentPeriod, ...usagePeriods, ...summaryPeriods, ...ledgerDates.map((row) => periodOf(row.createdAt))]);
    const availablePeriods = [...periods].filter((period) => period >= firstPeriod && period <= currentPeriod).sort().reverse();
    const history = await Promise.all(availablePeriods.map((period) => getUsage(ownerId, period)));
    const limit = selectedPeriod === currentPeriod ? limitsOf(req.user).messages : 0;
    res.json({
      period: selectedPeriod,
      timezone: config.USAGE_TIMEZONE,
      currentPeriod,
      periods: availablePeriods,
      approximate: selected.approximate,
      source: selected.source,
      messages: {
        used: selected.messages,
        sent: selected.messagesSent,
        failed: selected.messagesFailed,
        simulated: selected.simulatedMessages,
        limit,
        remaining: limit > 0 ? Math.max(0, limit - selected.messages) : 0,
      },
      creditsSpent: selected.creditsSpent,
      voiceCalls: selected.voiceCalls,
      campaignsStarted: selected.campaignsStarted,
      lastMonthSummary: summary ? { period: summary.period, ...summary.totals, approximate: summary.approximate } : null,
      contacts: { count: contacts, limit: limitsOf(req.user).contacts },
      history,
    });
  }),
);

router.get(
  '/credits',
  ah(async (req, res) => {
    const pp = pageParams(req.query, { defLimit: 20 });
    const { rows, total } = await listLedger(req.user._id, { page: pp.page, limit: pp.limit });
    const settings = await getSettings();
    res.json({ balance: req.user.credits || 0, costs: { message: settings.creditsPerMessage, call: settings.creditsPerCall }, ...pageResult(rows, total, pp) });
  }),
);

router.get('/audit', ah(async (req, res) => res.json(await listAudit({ ownerId: req.user._id }, req.query))));

router.patch(
  '/account',
  validate(z.object({ name: z.string().trim().min(1).max(120), companyName: z.string().trim().max(160).default(''), phone: z.string().trim().max(40).default('') }).partial().strict()),
  ah(async (req, res) => {
    const updated = await User.findOneAndUpdate({ _id: req.user._id }, { $set: req.body }, { new: true });
    await audit(req, 'account.update', { ownerId: req.user._id, meta: { fields: Object.keys(req.body) } });
    res.json({ user: updated });
  }),
);

module.exports = router;
