const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true }, // YYYY-MM (USAGE_TIMEZONE for new counters)
    messages: { type: Number, default: 0 },
    simulatedMessages: { type: Number, default: 0 },
    campaignsStarted: { type: Number, default: 0 },
    messagesSent: { type: Number, default: 0 },
    messagesFailed: { type: Number, default: 0 },
    creditsSpent: { type: Number, default: 0 },
    voiceCalls: { type: Number, default: 0 },
    countersVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

schema.index({ ownerId: 1, period: 1 }, { unique: true });
schema.index({ period: 1 });

module.exports = mongoose.model('Usage', schema);
