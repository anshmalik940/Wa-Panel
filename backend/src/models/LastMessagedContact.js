const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('LastMessagedContact', schema);
