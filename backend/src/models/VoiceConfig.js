const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Platform-wide voice-calling (CLI / caller-ID) provider settings. One document, key "default".
 * mode "mock": simulated calls (free, never real). mode "http": a generic HTTP call API described by the templates below,
 * so any telecom/voice vendor can be plugged in by filling URL + API key + body template (no code change).
 */
const schema = new Schema(
  {
    key: { type: String, default: 'default', unique: true },
    mode: { type: String, enum: ['mock', 'http'], default: 'mock' },
    providerName: { type: String, default: '', trim: true, maxlength: 80 },
    apiUrl: { type: String, default: '', trim: true, maxlength: 500 },
    method: { type: String, enum: ['POST', 'GET'], default: 'POST' },
    contentType: { type: String, enum: ['json', 'form'], default: 'json' },
    // JSON object text. Placeholders: {{apiKey}} (headers only), {{to}} {{cli}} {{audio_url}} {{text}} {{name}} {{message_id}} {{campaign_id}}
    headersTemplate: { type: String, default: '{"Authorization": "Bearer {{apiKey}}"}', maxlength: 2000 },
    bodyTemplate: { type: String, default: '{"to": "{{to}}", "from": "{{cli}}", "audio_url": "{{audio_url}}", "text": "{{text}}", "reference": "{{message_id}}"}', maxlength: 4000 },
    apiKeyEnc: { type: String, default: '' },
    callIdPath: { type: String, default: 'call_id', trim: true, maxlength: 100 }, // dot path in the JSON response
    successPath: { type: String, default: '', trim: true, maxlength: 100 }, // optional: response field that must equal successValue
    successValue: { type: String, default: '', trim: true, maxlength: 100 },
    webhookToken: { type: String, required: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('VoiceConfig', schema);
