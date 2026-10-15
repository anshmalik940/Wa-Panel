const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    language: { type: String, required: true, default: 'en' },
    category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], default: 'MARKETING' },
    header: { type: String, default: '' },
    // 'text' uses `header`; image/video/document use an uploaded Media file (the "ad creative")
    headerType: { type: String, enum: ['none', 'text', 'image', 'video', 'document'], default: 'none' },
    attachmentType: { type: String, enum: ['none', 'image', 'video', 'document'] },
    mediaId: { type: Schema.Types.ObjectId, ref: 'Media', default: null },
    extraMediaIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Media' }], default: [] },
    body: { type: String, default: '' },
    footer: { type: String, default: '' },
    variables: { type: [String], default: [] },
    status: { type: String, enum: ['draft', 'pending', 'approved', 'rejected'], default: 'draft' },
    rejectionReason: { type: String, default: '' },
    providerTemplateId: { type: String, default: '' },
    providerTemplateName: { type: String, default: '' },
    syncSource: { type: String, enum: ['none', 'mock', 'meta', 'platform_meta'], default: 'none' },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

schema.index({ ownerId: 1, name: 1, language: 1 }, { unique: true });
schema.index({ ownerId: 1, status: 1 });
schema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('Template', schema);
