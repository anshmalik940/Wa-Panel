const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Ledger of every change to a wallet. `amount` is always positive; `type` says the direction.
 * Per-message usage is aggregated into ONE row per campaign (reason "campaign") instead of one row per message.
 */
const schema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 0 },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, enum: ['topup', 'transfer_in', 'transfer_out', 'adjustment', 'campaign', 'refund'], required: true },
    note: { type: String, default: '', maxlength: 300 },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '' },
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
  },
  { timestamps: true },
);

schema.index({ userId: 1, createdAt: -1 });
schema.index(
  { userId: 1, campaignId: 1, reason: 1 },
  {
    unique: true,
    name: 'user_campaign_reason_nonnull_unique',
    partialFilterExpression: { campaignId: { $type: 'objectId' } },
  },
);

module.exports = mongoose.model('CreditTransaction', schema);
