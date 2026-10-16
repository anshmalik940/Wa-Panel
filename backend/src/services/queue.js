const crypto = require('crypto');
const { Campaign, CampaignMessage, User } = require('../models');
const { config } = require('../config');
const { getSettings } = require('../utils/settings');
const { getProvider } = require('../providers');
const { ProviderError } = require('../providers/errors');
const { HttpError } = require('../utils/httpError');
const { remainingQuota, incrementUsage } = require('./usage');
const { startCampaign, materialize } = require('./campaignService');
const credits = require('./credits');
const voiceSvc = require('./voiceService');
const { resolveWhatsApp, NOT_READY } = require('./providerResolver');
const { rememberLastRecipient } = require('./messageAttribution');
const { cleanupOwner, cleanupAll } = require('./campaignRetention');
const { appliedCutting } = require('./cutting');

const MAX_ATTEMPTS = 3;
const STALE_MS = Number(process.env.WORKER_STALE_MS) || 120000;
const LEASE_MS = 120000;

let timer = null;
let busy = false;
let lastPlatformQrCampaignId = '';
let lastDailyCleanup = '';

/** Moves messages that were mid-flight when a process died back to a safe state. */
async function recoverStale({ staleMs = STALE_MS } = {}) {
  const cutoff = new Date(Date.now() - staleMs);
  const requeued = await CampaignMessage.updateMany(
    { status: 'sending', simulated: true, lockedAt: { $lte: cutoff } },
    { $set: { status: 'queued', error: 'Recovered after interrupted processing' } },
  );
  // A real send may or may not have reached the provider: never auto-retry (would risk a duplicate message).
  const staleFilter = { status: 'sending', simulated: false, lockedAt: { $lte: cutoff } };
  const unknownByOwner = new Map();
  let unknownCount = 0;
  const pausedCampaigns = new Set();
  for await (const msg of CampaignMessage.find(staleFilter).select('_id ownerId campaignId billing').lean().cursor()) {
    const updated = await CampaignMessage.updateOne(
      { _id: msg._id, status: 'sending' },
      {
        $set: {
          status: 'unknown',
          unknownAt: new Date(),
          error: 'Interrupted while sending; delivery outcome unknown and not retried to avoid a duplicate message',
          ...(msg.billing ? { 'billing.deliveryUnknown': true } : {}),
        },
      },
    );
    if (!updated.modifiedCount) continue;
    unknownCount += 1;
    pausedCampaigns.add(String(msg.campaignId));
    const ownerKey = String(msg.ownerId);
    const owner = unknownByOwner.get(ownerKey) || { id: msg.ownerId, count: 0, campaignCounts: new Map() };
    owner.count += 1;
    owner.campaignCounts.set(String(msg.campaignId), (owner.campaignCounts.get(String(msg.campaignId)) || 0) + 1);
    unknownByOwner.set(ownerKey, owner);
  }
  for (const owner of unknownByOwner.values()) {
    const campaigns = await Campaign.find({ _id: { $in: [...owner.campaignCounts.keys()] } }).select('_id channel').lean();
    let messages = 0;
    let voiceCalls = 0;
    for (const campaign of campaigns) {
      const count = owner.campaignCounts.get(String(campaign._id)) || 0;
      if (campaign.channel === 'voice') voiceCalls += count;
      else messages += count;
    }
    await incrementUsage(owner.id, { messages, unknown: owner.count, voiceCalls });
  }
  if (pausedCampaigns.size) {
    await Campaign.updateMany(
      { _id: { $in: [...pausedCampaigns] }, status: 'running' },
      { $set: { status: 'paused', pausedAt: new Date(), lastError: 'Paused because a provider outcome is unknown; uncertain messages are not retried.' } },
    );
  }
  let resumed = 0;
  for (const c of await Campaign.find({ status: 'queued', startedAt: { $lte: cutoff } })) {
    await materialize(c);
    resumed += 1;
  }
  return { requeued: requeued.modifiedCount, unknown: unknownCount, resumedCampaigns: resumed };
}

async function runScheduler() {
  const due = await Campaign.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } }).limit(20);
  for (const c of due) {
    try {
      await startCampaign(c);
    } catch (err) {
      if (err instanceof HttpError && err.status === 422) {
        const msg = (err.details?.issues || []).map((i) => i.message).join(' ') || err.message;
        await Campaign.updateOne({ _id: c._id, status: 'scheduled' }, { $set: { status: 'failed', lastError: `Scheduled start failed: ${msg}` } });
        await cleanupOwner(c.ownerId);
      } else if (!(err instanceof HttpError && err.status === 409)) {
        console.error('[queue] scheduler error for campaign', String(c._id), err);
      }
    }
  }
}

async function pauseRunning(campaignId, reason) {
  await Campaign.updateOne({ _id: campaignId, status: 'running' }, { $set: { status: 'paused', pausedAt: new Date(), lastError: reason, nextBatchAt: null } });
}

const PAUSE_CODES = new Set(['190', '10', '368', '131031', '131048', '131056', 'QR_NOT_CONNECTED', 'QR_LOGGED_OUT', 'REAL_SEND_DISABLED']);

function shouldPauseForProviderError(err) {
  return err.status === 401
    || err.status === 403
    || err.status === 429
    || isProviderOutcomeUnknown(err)
    || PAUSE_CODES.has(String(err.code || ''))
    || /logged out|account restricted|quality warning|quality limit/i.test(err.message || '');
}

function isProviderOutcomeUnknown(err) {
  return err.status >= 500 || ['NETWORK', 'WA_HTTP_TIMEOUT', 'WA_HTTP_NETWORK'].includes(String(err.code || ''));
}

/** Real sends are debited before provider submission and refunded when the provider rejects them. */
async function processMessage(campaign, resolved, msg, settings, voiceConfig = null) {
  const provider = campaign.channel === 'voice' ? getProvider(campaign.provider) : resolved.provider;
  const account = campaign.channel === 'voice' ? null : resolved.account;
  const unit = campaign.channel === 'voice' ? settings.creditsPerCall : settings.creditsPerMessage;
  const originalCharge = msg.simulated ? 0 : unit * (provider.costUnits ? provider.costUnits(msg, settings) : 1);
  const billing = msg.simulated ? null : {
    originalCharge,
    finalCharge: originalCharge,
    appliedAt: new Date(),
    refunded: false,
    deliveryUnknown: false,
  };
  const cost = billing ? billing.finalCharge : 0;
  if (billing) {
    await CampaignMessage.updateOne({ _id: msg._id, status: 'sending' }, { $set: { billing } });
    msg.billing = billing;
  }
  if (billing && !(await credits.charge(msg.ownerId, cost, campaign._id, billing))) {
    await CampaignMessage.updateOne(
      { _id: msg._id, status: 'sending' },
      { $set: { status: 'queued', error: 'Waiting for credits' }, $unset: { billing: 1 }, $inc: { attempts: -1 } },
    );
    return 'no_credits';
  }
  if (msg.isCut) {
    const cutAt = new Date();
    const updated = await CampaignMessage.updateOne(
      { _id: msg._id, status: 'sending' },
      { $set: { status: 'cut', cutAt, billing } },
    );
    if (updated.modifiedCount) {
      await incrementUsage(msg.ownerId, {
        messages: campaign.channel === 'voice' ? 0 : 1,
        cut: 1,
        voiceCalls: campaign.channel === 'voice' ? 1 : 0,
      });
      await appliedCutting(campaign, msg, cutAt);
    }
    return 'ok';
  }
  let result;
  try {
    result = await provider.send({ account, message: msg, campaign, settings, voiceConfig });
  } catch (err) {
    const known = err instanceof ProviderError;
    if (!known) console.error('[queue] unexpected error while sending', String(msg._id), err);
    const outcomeUnknown = !msg.simulated && (!known || isProviderOutcomeUnknown(err));
    const message = `${outcomeUnknown ? 'Provider outcome is unknown; the message will not be retried. ' : ''}${known ? err.message : `Internal error: ${err.message}`}`;
    const pauseForProvider = outcomeUnknown || (known && shouldPauseForProviderError(err));
    const retry = known && err.retryable && msg.attempts < MAX_ATTEMPTS && !pauseForProvider;
    // Refund only when the provider explicitly rejected the request; uncertain outcomes stay charged and are never retried.
    if (!outcomeUnknown && (cost || (billing && billing.originalCharge > 0))) {
      await credits.refund(msg.ownerId, cost, campaign._id, billing);
      if (billing) {
        billing.refunded = true;
        await CampaignMessage.updateOne({ _id: msg._id }, { $set: { billing } });
      }
    } else if (outcomeUnknown && billing) {
      billing.deliveryUnknown = true;
      await CampaignMessage.updateOne({ _id: msg._id }, { $set: { billing } });
    }
    if (retry) {
      await CampaignMessage.updateOne({ _id: msg._id, status: 'sending' }, { $set: { status: 'queued', error: message } });
    } else {
      await CampaignMessage.updateOne(
        { _id: msg._id, status: 'sending' },
        { $set: { status: msg.simulated ? 'simulated_failed' : outcomeUnknown ? 'unknown' : 'failed', ...(outcomeUnknown ? { unknownAt: new Date() } : { failedAt: new Date() }), error: message } },
      );
      if (outcomeUnknown) {
        await incrementUsage(msg.ownerId, { messages: campaign.channel === 'voice' ? 0 : 1, unknown: 1, voiceCalls: campaign.channel === 'voice' ? 1 : 0 });
      } else {
        await incrementUsage(msg.ownerId, { failed: 1 });
      }
    }
    const failures = await Campaign.findOneAndUpdate(
      { _id: campaign._id },
      { $inc: { consecutiveFailures: 1 } },
      { new: true },
    ).select('consecutiveFailures');
    const pause = pauseForProvider || (failures && failures.consecutiveFailures >= settings.campaignFailurePauseThreshold);
    if (pause) {
      await pauseRunning(campaign._id, pauseForProvider ? `Provider safety stop (${String(err.code || err.status || 'provider_error')})` : 'Paused after repeated consecutive provider failures');
      console.warn(JSON.stringify({ event: 'campaign.paused.safety', campaignId: String(campaign._id), code: String(err.code || err.status || 'provider_error') }));
      return 'pause';
    }
    return 'failed';
  }

  const sentAt = new Date();
  const updated = await CampaignMessage.updateOne(
    { _id: msg._id, status: 'sending' },
    { $set: { status: msg.simulated ? 'simulated_sent' : 'sent', providerMessageId: result.providerMessageId, sentAt, error: '' } },
  );
  if (updated.modifiedCount && campaign.channel !== 'voice' && !msg.simulated) {
    await rememberLastRecipient({ phone: msg.phone, ownerId: msg.ownerId, contactId: msg.contactId, campaignId: campaign._id, sentAt });
  }
  await incrementUsage(msg.ownerId, {
    messages: 1,
    simulated: msg.simulated ? 1 : 0,
    sent: msg.simulated ? 0 : 1,
    voiceCalls: campaign.channel === 'voice' ? 1 : 0,
  });
  await Campaign.updateOne({ _id: campaign._id }, { $set: { consecutiveFailures: 0 } });
  return 'ok';
}

async function processRunning(settings) {
  const now = new Date();
  const campaigns = await Campaign.find({
    status: 'running',
    $and: [
      { $or: [{ workerLeaseUntil: null }, { workerLeaseUntil: { $lte: now } }] },
      { $or: [{ nextBatchAt: null }, { nextBatchAt: { $lte: now } }] },
    ],
  }).sort({ _id: 1 }).limit(50);
  const startAfter = campaigns.findIndex((campaign) => String(campaign._id) === lastPlatformQrCampaignId);
  if (startAfter >= 0 && campaigns.length > 1) campaigns.push(...campaigns.splice(0, startAfter + 1));
  let processed = 0;
  for (const candidate of campaigns) {
    const leaseToken = crypto.randomUUID();
    const c = await Campaign.findOneAndUpdate(
      {
        _id: candidate._id,
        status: 'running',
        $and: [
          { $or: [{ workerLeaseUntil: null }, { workerLeaseUntil: { $lte: new Date() } }] },
          { $or: [{ nextBatchAt: null }, { nextBatchAt: { $lte: new Date() } }] },
        ],
      },
      { $set: { workerLeaseToken: leaseToken, workerLeaseUntil: new Date(Date.now() + LEASE_MS) } },
      { new: true },
    );
    if (!c) continue;
    let batchProcessed = 0;
    let provider = null;
    try {
    const owner = await User.findById(c.ownerId).select('status allowQr useOwnQr');
    if (!owner || owner.status !== 'active') {
      await pauseRunning(c._id, 'Account suspended');
      continue;
    }
    let account = null;
    let resolved = null;
    let voiceConfig = null;
    if (c.channel === 'voice') {
      voiceConfig = await voiceSvc.getConfig();
      if (!voiceSvc.isReady(voiceConfig).ok || voiceSvc.providerFor(voiceConfig) !== c.provider) {
        await pauseRunning(c._id, 'Voice calling is not configured (or the voice provider was changed)');
        continue;
      }
      provider = getProvider(c.provider);
    } else {
      resolved = await resolveWhatsApp(owner);
      if (!resolved.ready || resolved.providerName !== c.provider) {
        await pauseRunning(c._id, NOT_READY);
        continue;
      }
      account = resolved.account;
      provider = resolved.provider;
    }
    const quota = await remainingQuota(c.ownerId);
    if (quota.remaining <= 0) {
      await pauseRunning(c._id, 'Monthly message limit reached');
      continue;
    }
    // linked-phone sending is deliberately slow: one message per random pause, never a burst
    if (provider.paced && !provider.canSend(account)) {
      const next = provider.getNextSendAt ? provider.getNextSendAt(account) : null;
      await Campaign.updateOne(
        { _id: c._id, status: 'running', workerLeaseToken: leaseToken },
        { $set: { nextBatchAt: next } },
      );
      continue;
    }
    const budget = provider.paced ? 1 : Math.min(config.WORKER_BATCH_SIZE, settings.campaignBatchSize, quota.remaining);
    for (let i = 0; i < budget; i += 1) {
      const renewed = await Campaign.updateOne(
        { _id: c._id, status: 'running', workerLeaseToken: leaseToken },
        { $set: { workerLeaseUntil: new Date(Date.now() + LEASE_MS) } },
      );
      if (!renewed.modifiedCount) break;
      const state = await Campaign.findById(c._id).select('status workerLeaseToken');
      if (!state || state.status !== 'running' || state.workerLeaseToken !== leaseToken) break;
      const msg = await CampaignMessage.findOneAndUpdate(
        { campaignId: c._id, status: 'queued' },
        { $set: { status: 'sending', lockedAt: new Date() }, $inc: { attempts: 1 } },
        { sort: { _id: 1 }, new: true },
      );
      if (!msg) break;
      // Re-check right before the point of no return: a cancel/pause that landed between the status
      // check above and the claim must not let this message go out.
      const after = await Campaign.findById(c._id).select('status');
      if (!after || after.status !== 'running') {
        const back = after && after.status === 'cancelled' ? 'cancelled' : 'queued';
        await CampaignMessage.updateOne({ _id: msg._id, status: 'sending' }, { $set: { status: back }, $inc: { attempts: -1 } });
        break;
      }
      const outcome = await processMessage(c, resolved, msg, settings, voiceConfig);
      batchProcessed += 1;
      if (c.channel !== 'voice' && resolved.source === 'platform' && resolved.providerName === 'qr') {
        lastPlatformQrCampaignId = String(c._id);
      }
      if (outcome === 'no_credits') {
        await pauseRunning(c._id, 'Not enough credits. Add credits, then resume the campaign.');
        break;
      }
      if (outcome === 'pause') break;
      processed += 1;
    }
    const pending = await CampaignMessage.countDocuments({ campaignId: c._id, status: { $in: ['queued', 'sending'] } });
    if (pending === 0) {
      const done = await Campaign.updateOne({ _id: c._id, status: 'running', workerLeaseToken: leaseToken }, { $set: { status: 'completed', completedAt: new Date(), nextBatchAt: null } });
      if (done.modifiedCount) await cleanupOwner(c.ownerId);
    } else if (!provider.paced && batchProcessed >= budget && settings.campaignBatchDelayMs > 0) {
      await Campaign.updateOne(
        { _id: c._id, status: 'running', workerLeaseToken: leaseToken },
        { $set: { nextBatchAt: new Date(Date.now() + settings.campaignBatchDelayMs) } },
      );
    }
    } finally {
      await Campaign.updateOne(
        { _id: c._id, workerLeaseToken: leaseToken },
        { $set: { workerLeaseToken: '', workerLeaseUntil: null } },
      );
    }
  }
  return processed;
}

/** Mock provider only: walks simulated_sent -> simulated_delivered -> simulated_read over time. */
async function advanceSimulated(settings) {
  const now = Date.now();
  const delivered = await CampaignMessage.updateMany(
    { status: 'simulated_sent', sentAt: { $lte: new Date(now - settings.mockDeliveryDelayMs) } },
    { $set: { status: 'simulated_delivered', deliveredAt: new Date() } },
  );
  const read = await CampaignMessage.updateMany(
    { status: 'simulated_delivered', mockWillRead: true, deliveredAt: { $lte: new Date(now - settings.mockReadDelayMs) } },
    { $set: { status: 'simulated_read', readAt: new Date() } },
  );
  return { delivered: delivered.modifiedCount, read: read.modifiedCount };
}

/** One worker pass. Exported so tests (and operators) can drive the queue deterministically. */
async function tick() {
  if (busy) return { skipped: true };
  busy = true;
  try {
    const settings = await getSettings();
    await recoverStale();
    await runScheduler();
    const processed = await processRunning(settings);
    const sim = await advanceSimulated(settings);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: config.USAGE_TIMEZONE }).format(new Date());
    if (lastDailyCleanup !== day) {
      await cleanupAll();
      lastDailyCleanup = day;
    }
    return { processed, ...sim };
  } finally {
    busy = false;
  }
}

function startWorker() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((err) => console.error('[queue] tick failed', err));
  }, config.WORKER_INTERVAL_MS);
  timer.unref();
}

function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { tick, startWorker, stopWorker, recoverStale, advanceSimulated, shouldPauseForProviderError, isProviderOutcomeUnknown, processMessage };
