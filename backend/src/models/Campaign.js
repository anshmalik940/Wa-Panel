const mongoose = require('mongoose');

const { Schema } = mongoose;

const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'queued', 'running', 'paused', 'completed', 'cancelled', 'failed'];

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // 'whatsapp' campaigns send a template; 'voice' campaigns place calls (CLI + audio file and/or spoken text)
    channel: { type: String, enum: ['whatsapp', 'voice'], default: 'whatsapp' },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', required() { return this.channel !== 'voice'; } },
    voice: {
      cliNumberId: { type: Schema.Types.ObjectId, ref: 'CliNumber', default: null },
      audioMediaId: { type: Schema.Types.ObjectId, ref: 'Media', default: null },
      text: { type: String, default: '', maxlength: 1000 },
    },
    templateName: { type: String, default: '' },
    templateSnapshot: { type: Schema.Types.Mixed, default: null },
    audience: {
      mode: { type: String, enum: ['all', 'groups', 'contacts'], default: 'all' },
      groups: { type: [String], default: [] },
      contactIds: { type: [Schema.Types.ObjectId], default: [] },
    },
    variableMap: { type: Schema.Types.Mixed, default: {} },
    scheduledAt: { type: Date, default: null },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'draft' },
    provider: { type: String, enum: ['mock', 'meta', 'qr', 'wa_http', 'voice_mock', 'voice_http', ''], default: '' },
    // client generated key: re-submitting the same form never creates a second campaign
    submissionKey: { type: String, required: true },
    recipientCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, minimize: false },
);

schema.index({ ownerId: 1, submissionKey: 1 }, { unique: true });
schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ ownerId: 1, status: 1, createdAt: -1 });
schema.index({ status: 1, scheduledAt: 1 });

module.exports = mongoose.model('Campaign', schema);
module.exports.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;
