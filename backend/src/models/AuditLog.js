const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    actorEmail: { type: String, default: 'system' },
    actorRole: { type: String, default: 'system' },
    action: { type: String, required: true },
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '' },
    // tenant (customer id) the event belongs to, when applicable
    ownerId: { type: Schema.Types.ObjectId, default: null },
    meta: { type: Schema.Types.Mixed, default: {} },
    ip: { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

schema.index({ createdAt: -1 });
schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ actorId: 1, createdAt: -1 });
schema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', schema);
