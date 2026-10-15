const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    provider: { type: String, enum: ['mock', 'meta', 'qr', 'wa_http'], default: 'mock' },
    displayName: { type: String, trim: true, default: '', maxlength: 120 },
    phoneNumberId: { type: String, trim: true, default: '' },
    wabaId: { type: String, trim: true, default: '' },
    appId: { type: String, trim: true, default: '' }, // Meta App ID: only needed to submit templates that have an image/video/document header
    accessTokenEnc: { type: String, default: '' },
    appSecretEnc: { type: String, default: '' },
    verifyToken: { type: String, required: true, unique: true },
    status: { type: String, enum: ['not_configured', 'connected', 'error'], default: 'not_configured' },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    displayPhone: { type: String, default: '' },
    verifiedName: { type: String, default: '' },
  },
  { timestamps: true },
);

schema.index({ phoneNumberId: 1 });

module.exports = mongoose.model('WhatsAppAccount', schema);
