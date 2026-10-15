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

const MAX_ATTEMPTS = 3;
const STALE_MS = Number(process.env.WORKER_STALE_MS) || 120000;

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
  const staleOwners = await CampaignMessage.aggregate([
    { $match: { status: 'sending', simulated: false, lockedAt: { $lte: cutoff } } },
    { $group: { _id: '$ownerId', count: { $sum: 1 } } },
  ]);
  let failedCount = 0;
  for (const owner of staleOwners) {
    const result = await CampaignMessage.updateMany(
      { ownerId: owner._id, status: 'sending', simulated: false, lockedAt: { $lte: cutoff } },
      { $set: { status: 'failed', failedAt: new Date(), error: 'Interrupted while sending; delivery outcome unknown and not retried to avoid a duplicate message' } },
    );
    failedCount += result.modifiedCount;
    if (result.modifiedCount) await incrementUsage(owner._id, { failed: result.modifiedCount });
  }
  let resumed = 0;
  for (const c of await Campaign.find({ status: 'queued', startedAt: { $lte: cutoff } })) {
    await materialize(c);
    resumed += 1;
  }
  return { requeued: requeued.modifiedCount, failed: failedCount, resumedCampaigns: resumed };
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
  await Campaign.updateOne({ _id: campaignId, status: 'running' }, { $set: { status: 'paused', pausedAt: new Date(), lastError: reason } });
}

/** Returns 'ok' | 'no_credits'. Real (non-simulated) messages are paid for from the owner's wallet before sending. */
async function processMessage(campaign, resolved, msg, settings, voiceConfig = null) {
  const provider = campaign.channel === 'voice' ? getProvider(campaign.provider) : resolved.provider;
  const account = campaign.channel === 'voice' ? null : resolved.account;
  const unit = campaign.channel === 'voice' ? settings.creditsPerCall : settings.creditsPerMessage;
  const cost = msg.simulated ? 0 : unit * (provider.costUnits ? provider.costUnits(msg, settings) : 1);
  if (cost && !(await credits.charge(msg.ownerId, cost, campaign._id))) {
    await CampaignMessage.updateOne({ _id: msg._id, status: 'sending' }, { $set: { status: 'queued', error: 'Waiting for credits' }, $inc: { attempts: -1 } });
    return 'no_credits';
  }
  try {
    const result = await provider.send({ account, message: msg, campaign, settings, voiceConfig });
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
    return 'ok';
  } catch (err) {
    const known = err instanceof ProviderError;
    if (!known) console.error('[queue] unexpected error while sending', String(msg._id), err);
    const message = known ? err.message : `Internal error: ${err.message}`;
    if (known && err.retryable && msg.attempts < MAX_ATTEMPTS) {
      await CampaignMessage.updateOne({ _id: msg._id, status: 'sending' }, { $set: { status: 'queued', error: message } });
    } else {
      await CampaignMessage.updateOne(
        { _id: msg._id, status: 'sending' },
        { $set: { status: msg.simulated ? 'simulated_failed' : 'failed', failedAt: new Date(), error: message } },
      );
      await incrementUsage(msg.ownerId, { failed: 1 });
    }
    // a message that did not go out is not paid for
    if (cost) await credits.refund(msg.ownerId, cost, campaign._id);
    return 'failed';
  }
}

async function processRunning(settings) {
  const campaigns = await Campaign.find({ status: 'running' }).sort({ _id: 1 }).limit(50);
  const startAfter = campaigns.findIndex((campaign) => String(campaign._id) === lastPlatformQrCampaignId);
  if (startAfter >= 0 && campaigns.length > 1) campaigns.push(...campaigns.splice(0, startAfter + 1));
  let processed = 0;
  for (const c of campaigns) {
    const owner = await User.findById(c.ownerId).select('status allowQr useOwnQr');
    if (!owner || owner.status !== 'active') {
      await pauseRunning(c._id, 'Account suspended');
      continue;
    }
    let account = null;
    let resolved = null;
    let voiceConfig = null;
    let provider;
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
    if (provider.paced && !provider.canSend(account)) continue;
    const budget = provider.paced ? 1 : Math.min(config.WORKER_BATCH_SIZE, quota.remaining);
    for (let i = 0; i < budget; i += 1) {
      const state = await Campaign.findById(c._id).select('status');
      if (!state || state.status !== 'running') break; // paused/cancelled mid-batch
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
      if (c.channel !== 'voice' && resolved.source === 'platform' && resolved.providerName === 'qr') {
        lastPlatformQrCampaignId = String(c._id);
      }
      if (outcome === 'no_credits') {
        await pauseRunning(c._id, 'Not enough credits. Add credits, then resume the campaign.');
        break;
      }
      processed += 1;
    }
    const pending = await CampaignMessage.countDocuments({ campaignId: c._id, status: { $in: ['queued', 'sending'] } });
    if (pending === 0) {
      const done = await Campaign.updateOne({ _id: c._id, status: 'running' }, { $set: { status: 'completed', completedAt: new Date() } });
      if (done.modifiedCount) await cleanupOwner(c.ownerId);
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

module.exports = { tick, startWorker, stopWorker, recoverStale, advanceSimulated };
