const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, trim: true, default: '', maxlength: 120 },
    phone: { type: String, required: true, trim: true, maxlength: 40 },
    phoneValid: { type: Boolean, default: true },
    email: { type: String, trim: true, lowercase: true, default: '', maxlength: 200 },
    groups: { type: [String], default: [] },
    attributes: { type: Schema.Types.Mixed, default: {} },
    optedOut: { type: Boolean, default: false },
    optedOutAt: { type: Date, default: null },
    optOutSource: { type: String, default: '' },
  },
  { timestamps: true, minimize: false },
);

schema.index({ ownerId: 1, phone: 1 }, { unique: true });
schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ ownerId: 1, groups: 1 });
schema.index({ ownerId: 1, optedOut: 1 });
schema.index({ ownerId: 1, email: 1 });

module.exports = mongoose.model('Contact', schema);
