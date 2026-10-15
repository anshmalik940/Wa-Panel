const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    campaignId: { type: Schema.Types.ObjectId, required: true },
    createdAt: { type: Date, required: true },
    status: { type: String, required: true },
    channel: { type: String, default: 'whatsapp' },
    messageBuckets: [{
      at: { type: Date, required: true },
      status: { type: String, required: true },
      count: { type: Number, required: true },
    }],
  },
  { timestamps: true },
);

schema.index({ campaignId: 1 }, { unique: true });
schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ ownerId: 1, 'messageBuckets.at': 1 });

module.exports = mongoose.model('CampaignArchive', schema);
