const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    percentage: { type: Number, required: true, min: 0, max: 100 },
    ruleKey: { type: String, required: true },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    internalReason: { type: String, default: '', maxlength: 500 },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    changedByName: { type: String, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('CampaignCutting', schema);
