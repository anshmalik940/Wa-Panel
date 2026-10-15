const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },
    activeProvider: { type: String, enum: ['mock', 'wa_http', 'meta', 'qr'], default: 'mock' },
    mode: { type: String, enum: ['off', 'http'], default: 'off' },
    providerName: { type: String, default: '', trim: true, maxlength: 80 },
    baseUrl: { type: String, default: '', trim: true, maxlength: 1000 },
    method: { type: String, enum: ['GET', 'POST'], default: 'GET' },
    contentType: { type: String, enum: ['query', 'json', 'form'], default: 'query' },
    apiKeyEnc: { type: String, default: '' },
    defaultCaption: { type: String, default: '', trim: true, maxlength: 200 },
    paramNames: {
      apikey: { type: String, default: 'apikey', trim: true, maxlength: 80 },
      mobile: { type: String, default: 'mobile', trim: true, maxlength: 80 },
      msg: { type: String, default: 'msg', trim: true, maxlength: 80 },
      pdf: { type: String, default: 'pdf', trim: true, maxlength: 80 },
      img1: { type: String, default: 'img1', trim: true, maxlength: 80 },
      img2: { type: String, default: 'img2', trim: true, maxlength: 80 },
      country: { type: String, default: 'country', trim: true, maxlength: 80 },
    },
    country: { type: String, default: 'IN', trim: true, maxlength: 10 },
    mobileFormat: { type: String, enum: ['national', 'international'], default: 'national' },
    successPath: { type: String, default: '', trim: true, maxlength: 100 },
    successValue: { type: String, default: '', trim: true, maxlength: 100 },
    messageIdPath: { type: String, default: '', trim: true, maxlength: 100 },
    mediaMapping: {
      image: { type: String, default: 'img1', trim: true, maxlength: 80 },
      document: { type: String, default: 'pdf', trim: true, maxlength: 80 },
    },
    meta: {
      phoneNumberId: { type: String, default: '', trim: true, maxlength: 80 },
      wabaId: { type: String, default: '', trim: true, maxlength: 80 },
      appId: { type: String, default: '', trim: true, maxlength: 80 },
      accessTokenEnc: { type: String, default: '' },
      appSecretEnc: { type: String, default: '' },
      verifyTokenEnc: { type: String, default: '' },
      graphVersion: { type: String, default: '', trim: true, maxlength: 20 },
      status: { type: String, enum: ['not_configured', 'connected', 'error'], default: 'not_configured' },
      lastCheckedAt: { type: Date, default: null },
      lastError: { type: String, default: '' },
      displayPhone: { type: String, default: '' },
      verifiedName: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

// Keep the existing collection and encrypted vendor configuration during the model transition.
module.exports = mongoose.models.PlatformWhatsApp || mongoose.model('PlatformWhatsApp', schema, 'whatsappapiconfigs');
