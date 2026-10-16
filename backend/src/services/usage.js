const { Usage, User, CreditTransaction, MonthlyUsageSummary } = require('../models');
const { config } = require('../config');
const { getSettings } = require('../utils/settings');

const pad = (value) => String(value).padStart(2, '0');

function periodOf(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: config.USAGE_TIMEZONE, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year').value;
  const month = parts.find((part) => part.type === 'month').value;
  return `${year}-${month}`;
}

function shiftPeriod(period, offset) {
  const [year, month] = period.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

function periodStart(period) {
  const [year, month] = period.split('-').map(Number);
  const target = Date.UTC(year, month - 1, 1);
  let guess = target;
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: config.USAGE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 4; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function periodBounds(period) {
  const start = periodStart(period);
  return { start, end: periodStart(shiftPeriod(period, 1)) };
}

async function legacyLedger(ownerId, period) {
  const { start, end } = periodBounds(period);
  const rows = await CreditTransaction.find({
    userId: ownerId,
    reason: { $in: ['campaign', 'refund'] },
    createdAt: { $gte: start, $lt: end },
  }).select('type amount reason').lean();
  let creditsSpent = 0;
  for (const row of rows) {
    if (row.reason === 'campaign' && row.type === 'debit') creditsSpent += row.amount;
    if (row.reason === 'refund' && row.type === 'credit') creditsSpent -= row.amount;
  }
  return Math.max(0, creditsSpent);
}

async function incrementUsage(ownerId, {
  messages = 0,
  simulated = 0,
  campaigns = 0,
  sent = 0,
  failed = 0,
  unknown = 0,
  cut = 0,
  creditsSpent = 0,
  voiceCalls = 0,
} = {}, date = new Date()) {
  await Usage.updateOne(
    { ownerId, period: periodOf(date) },
    {
      $inc: {
        messages,
        simulatedMessages: simulated,
        campaignsStarted: campaigns,
        messagesSent: sent,
        messagesFailed: failed,
        messagesUnknown: unknown,
        messagesCut: cut,
        creditsSpent,
        voiceCalls,
      },
      $set: { countersVersion: 1 },
    },
    { upsert: true },
  );
}

async function getUsage(ownerId, period = periodOf()) {
  const doc = await Usage.findOne({ ownerId, period }).lean();
  const isCurrent = period === periodOf();
  const hasCounters = Boolean(doc && doc.countersVersion >= 1);
  const messages = doc?.messages || 0;
  const simulatedMessages = doc?.simulatedMessages || 0;
  const campaignsStarted = doc?.campaignsStarted || 0;
  if (hasCounters) {
    const data = {
      period,
      messages,
      simulatedMessages,
      campaignsStarted,
      messagesSent: doc.messagesSent,
      messagesFailed: doc.messagesFailed,
      messagesUnknown: doc.messagesUnknown || 0,
      messagesCut: doc.messagesCut || 0,
      creditsSpent: doc.creditsSpent,
      voiceCalls: doc.voiceCalls,
      approximate: false,
      source: 'usage_counters',
      exists: true,
    };
    if (!isCurrent) {
      const summary = await MonthlyUsageSummary.findOne({ ownerId, period }).lean();
      if (summary) return { ...data, ...summary.totals, summary: true, approximate: Boolean(summary.approximate) };
    }
    return data;
  }
  const [ledgerCredits, settings] = await Promise.all([legacyLedger(ownerId, period), getSettings()]);
  const fallbackSent = Math.max(0, messages - simulatedMessages);
  const fallbackMessageCount = settings.creditsPerMessage > 0
    ? Math.floor(ledgerCredits / settings.creditsPerMessage)
    : 0;
  const data = {
    period,
    messages: messages || fallbackMessageCount,
    simulatedMessages,
    campaignsStarted,
    messagesSent: fallbackSent || fallbackMessageCount,
    messagesFailed: 0,
    messagesUnknown: 0,
    messagesCut: 0,
    creditsSpent: ledgerCredits,
    voiceCalls: 0,
    approximate: true,
    source: doc ? 'legacy_usage_and_ledger' : ledgerCredits ? 'credit_ledger' : 'usage_counters',
    exists: Boolean(doc || ledgerCredits),
  };
  return data;
}

async function finalizeMonthlySummary(ownerId, period) {
  const existing = await MonthlyUsageSummary.findOne({ ownerId, period }).lean();
  if (existing) return existing;
  const usage = await Usage.findOne({ ownerId, period }).lean();
  if (!usage) return null;
  const hasCounters = usage.countersVersion >= 1;
  const totals = hasCounters
    ? {
      messagesSent: usage.messagesSent,
      messagesFailed: usage.messagesFailed,
      messagesUnknown: usage.messagesUnknown || 0,
      messagesCut: usage.messagesCut || 0,
      simulatedMessages: usage.simulatedMessages,
      creditsSpent: usage.creditsSpent,
      voiceCalls: usage.voiceCalls,
      campaignsStarted: usage.campaignsStarted,
    }
    : {
      messagesSent: Math.max(0, usage.messages - usage.simulatedMessages),
      messagesFailed: 0,
      messagesUnknown: 0,
      messagesCut: 0,
      simulatedMessages: usage.simulatedMessages,
      creditsSpent: await legacyLedger(ownerId, period),
      voiceCalls: 0,
      campaignsStarted: usage.campaignsStarted,
    };
  try {
    return await MonthlyUsageSummary.findOneAndUpdate(
      { ownerId, period },
      { $setOnInsert: { ownerId, period, totals, approximate: !hasCounters, finalizedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (err) {
    if (err && err.code === 11000) return MonthlyUsageSummary.findOne({ ownerId, period }).lean();
    throw err;
  }
}

async function finalizePreviousMonth(ownerId, date = new Date()) {
  const current = periodOf(date);
  return finalizeMonthlySummary(ownerId, shiftPeriod(current, -1));
}

const UNLIMITED = 1000000000;

function limitsOf(user) {
  if (!user) return { messages: 0, contacts: 0, unlimited: false };
  if (user.role === 'reseller' || user.role === 'admin') return { messages: UNLIMITED, contacts: UNLIMITED, unlimited: true };
  return { messages: user.monthlyMessageLimit, contacts: user.contactLimit, unlimited: false };
}

async function remainingQuota(ownerId) {
  const [owner, usage] = await Promise.all([
    User.findById(ownerId).select('role monthlyMessageLimit contactLimit'),
    Usage.findOne({ ownerId, period: periodOf() }).select('messages').lean(),
  ]);
  const limit = limitsOf(owner).messages;
  const used = usage ? usage.messages : 0;
  return { limit, used, remaining: Math.max(0, limit - used) };
}

module.exports = {
  periodOf,
  shiftPeriod,
  periodStart,
  periodBounds,
  incrementUsage,
  getUsage,
  finalizeMonthlySummary,
  finalizePreviousMonth,
  remainingQuota,
  limitsOf,
  UNLIMITED,
};
