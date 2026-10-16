const crypto = require('crypto');
const { CampaignCutting } = require('../models');
const { audit } = require('../utils/audit');

function cutCountFor(eligibleCount, percentage) {
  if (!Number.isSafeInteger(eligibleCount) || eligibleCount < 0) throw new TypeError('Eligible recipient count must be a non-negative safe integer');
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw new TypeError('Cutting percentage must be between 0 and 100');
  return Math.min(eligibleCount, Math.round(eligibleCount * percentage / 100));
}

function randomCutIndexes(itemCount, sampleCount, random = Math.random) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0 || !Number.isSafeInteger(sampleCount) || sampleCount < 0 || sampleCount > itemCount) {
    throw new TypeError('Random sample sizes must be safe integers with sample count no greater than item count');
  }
  const sample = Array.from({ length: sampleCount }, (_, index) => index);
  for (let index = sampleCount; index < itemCount; index += 1) {
    const replacement = Math.floor(random() * (index + 1));
    if (replacement < sampleCount) sample[replacement] = index;
  }
  return new Set(sample);
}

function seededRandom(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let state = digest.readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function cuttingEligible(cutting, now = new Date()) {
  return Boolean(
    cutting
    && cutting.active
    && cutting.startsAt <= now
    && (!cutting.expiresAt || cutting.expiresAt > now),
  );
}

async function activeCutting(userId, now = new Date()) {
  return CampaignCutting.findOne({
    userId,
    active: true,
    startsAt: { $lte: now },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  }).select('percentage ruleKey').lean();
}

async function currentCutting(userId, now = new Date()) {
  const cutting = await CampaignCutting.findOne({ userId })
    .select('percentage startsAt expiresAt active')
    .lean();
  if (!cutting) return null;
  return {
    percentage: cutting.percentage,
    startsAt: cutting.startsAt,
    expiresAt: cutting.expiresAt,
    active: cutting.active,
    eligible: cuttingEligible(cutting, now),
  };
}

async function appliedCutting(campaign, message, appliedAt = new Date()) {
  if (!campaign.cuttingPercentage) return;
  await audit(null, 'cutting.applied', {
    targetType: 'campaign',
    targetId: campaign._id,
    ownerId: message.ownerId,
    meta: {
      messageId: String(message._id),
      percentage: campaign.cuttingPercentage,
      appliedAt,
    },
  });
}

module.exports = { cutCountFor, randomCutIndexes, seededRandom, cuttingEligible, activeCutting, currentCutting, appliedCutting };
