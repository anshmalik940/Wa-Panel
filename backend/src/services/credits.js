const { User, CreditTransaction } = require('../models');
const { HttpError } = require('../utils/httpError');
const { incrementUsage } = require('./usage');

/**
 * Wallet operations. MongoDB has no multi-document transaction guarantee on every deployment (free tier,
 * FerretDB), so each balance change is ONE atomic conditional $inc, and multi-step transfers compensate on failure.
 */

async function atomicCredit(userId, amount) {
  return User.findOneAndUpdate({ _id: userId }, { $inc: { credits: amount } }, { new: true });
}

/** Returns the updated user, or null when the balance is too low (nothing is changed in that case). */
async function atomicDebit(userId, amount) {
  return User.findOneAndUpdate({ _id: userId, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
}

async function ledger(user, { type, amount, reason, note = '', actor = null, counterparty = null, campaignId = null }) {
  return CreditTransaction.create({
    userId: user._id,
    type,
    amount,
    balanceAfter: user.credits,
    reason,
    note,
    actorId: actor ? actor._id : null,
    actorName: actor ? actor.name : '',
    counterpartyId: counterparty ? counterparty._id : null,
    campaignId,
  });
}

/**
 * Add credits to `target`.
 *  - admin: creates credits out of thin air (selling credits to a reseller or direct customer).
 *  - reseller: moves credits from the reseller's own wallet to one of their customers.
 */
async function addCredits({ actor, target, amount, note }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Amount must be a whole number greater than 0');
  if (actor.role === 'admin') {
    const updated = await atomicCredit(target._id, amount);
    await ledger(updated, { type: 'credit', amount, reason: 'topup', note, actor });
    return { target: updated, actor: null };
  }
  const debited = await atomicDebit(actor._id, amount);
  if (!debited) throw new HttpError(422, `Not enough credits in your wallet to transfer ${amount}. Ask your administrator to add credits to your account.`);
  let credited;
  try {
    credited = await atomicCredit(target._id, amount);
  } catch (err) {
    await atomicCredit(actor._id, amount); // compensate
    throw err;
  }
  await ledger(debited, { type: 'debit', amount, reason: 'transfer_out', note: note || `To ${target.name}`, actor, counterparty: target });
  await ledger(credited, { type: 'credit', amount, reason: 'transfer_in', note: note || `From ${actor.name}`, actor, counterparty: actor });
  return { target: credited, actor: debited };
}

/**
 * Remove credits from `target`.
 *  - admin: removes (adjustment, credits vanish).
 *  - reseller: reclaims credits from their customer back into the reseller's wallet.
 */
async function deductCredits({ actor, target, amount, note }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Amount must be a whole number greater than 0');
  const taken = await atomicDebit(target._id, amount);
  if (!taken) throw new HttpError(422, `${target.name} only has ${target.credits || 0} credits; cannot remove ${amount}.`);
  if (actor.role === 'admin') {
    await ledger(taken, { type: 'debit', amount, reason: 'adjustment', note, actor });
    return { target: taken, actor: null };
  }
  let back;
  try {
    back = await atomicCredit(actor._id, amount);
  } catch (err) {
    await atomicCredit(target._id, amount);
    throw err;
  }
  await ledger(taken, { type: 'debit', amount, reason: 'transfer_out', note: note || `Reclaimed by ${actor.name}`, actor, counterparty: actor });
  await ledger(back, { type: 'credit', amount, reason: 'transfer_in', note: note || `Reclaimed from ${target.name}`, actor, counterparty: target });
  return { target: taken, actor: back };
}

/** Charge for one real message/call. Returns true when charged (or free), false when the wallet is empty. */
async function charge(ownerId, cost, campaignId) {
  if (!cost) return true;
  const updated = await atomicDebit(ownerId, cost);
  if (!updated) return false;
  await bumpCampaignRow(updated, { type: 'debit', amount: cost, campaignId, reason: 'campaign' });
  await incrementUsage(ownerId, { creditsSpent: cost });
  return true;
}

async function refund(ownerId, cost, campaignId) {
  if (!cost) return;
  const updated = await atomicCredit(ownerId, cost);
  await bumpCampaignRow(updated, { type: 'credit', amount: cost, campaignId, reason: 'refund' });
  await incrementUsage(ownerId, { creditsSpent: -cost });
}

async function bumpCampaignRow(user, { type, amount, campaignId, reason }) {
  await CreditTransaction.updateOne(
    { userId: user._id, campaignId, reason },
    { $inc: { amount }, $set: { type, balanceAfter: user.credits, note: reason === 'campaign' ? 'Messages/calls sent by this campaign' : 'Refund for failed messages/calls' } },
    { upsert: true },
  );
}

async function listLedger(userId, { page = 1, limit = 20 } = {}) {
  const skip = (page - 1) * limit;
  const [rows, total] = await Promise.all([
    CreditTransaction.find({ userId }).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    CreditTransaction.countDocuments({ userId }),
  ]);
  return { rows, total };
}

module.exports = { addCredits, deductCredits, charge, refund, listLedger };
