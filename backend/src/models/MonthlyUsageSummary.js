const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    period: { type: String, required: true },
    totals: {
      messagesSent: { type: Number, default: 0 },
      messagesFailed: { type: Number, default: 0 },
      simulatedMessages: { type: Number, default: 0 },
      creditsSpent: { type: Number, default: 0 },
      voiceCalls: { type: Number, default: 0 },
      campaignsStarted: { type: Number, default: 0 },
    },
    approximate: { type: Boolean, default: false },
    finalizedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

schema.index({ ownerId: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('MonthlyUsageSummary', schema);
