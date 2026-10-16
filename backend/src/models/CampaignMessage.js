const mongoose = require('mongoose');

const { Schema } = mongoose;

// "simulated_*" statuses are produced only by the mock provider. They are never real deliveries.
const MESSAGE_STATUSES = [
  'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown', 'cut',
  'simulated_sent', 'simulated_delivered', 'simulated_read', 'simulated_failed',
  'excluded', 'cancelled',
];

const schema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    phone: { type: String, required: true },
    contactName: { type: String, default: '' },
    text: { type: String, default: '' },
    params: { type: Schema.Types.Mixed, default: {} },
    media: { type: Schema.Types.Mixed, default: null }, // { kind, url, name, mime } attached to this message
    status: { type: String, enum: MESSAGE_STATUSES, default: 'queued' },
    simulated: { type: Boolean, default: false },
    isCut: { type: Boolean, default: false },
    cuttingPercentage: { type: Number, default: 0, min: 0, max: 100 },
    mockWillRead: { type: Boolean, default: false },
    excludedReason: { type: String, default: '' },
    providerMessageId: { type: String, default: '' },
    error: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    unknownAt: { type: Date, default: null },
    cutAt: { type: Date, default: null },
    billing: {
      originalCharge: { type: Number, min: 0 },
      finalCharge: { type: Number, min: 0 },
      appliedAt: { type: Date, default: null },
      refunded: { type: Boolean, default: false },
      deliveryUnknown: { type: Boolean, default: false },
      progressReserved: { type: Boolean, default: false },
    },
  },
  { timestamps: true, minimize: false },
);

// A contact can appear at most once per campaign: the hard guarantee against duplicate sends.
schema.index({ campaignId: 1, contactId: 1 }, { unique: true });
schema.index({ campaignId: 1, status: 1 });
schema.index({ status: 1, lockedAt: 1 });
schema.index({ status: 1, sentAt: 1 });
schema.index({ providerMessageId: 1 });
schema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('CampaignMessage', schema);
module.exports.MESSAGE_STATUSES = MESSAGE_STATUSES;
