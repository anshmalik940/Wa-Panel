const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    summary: { type: String, default: '' },
    outcome: { type: String, enum: ['applied', 'ignored'], default: 'applied' },
  },
  { timestamps: true },
);

schema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('WebhookEvent', schema);
