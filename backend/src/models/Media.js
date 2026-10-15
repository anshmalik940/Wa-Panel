const mongoose = require('mongoose');

const { Schema } = mongoose;

const schema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['image', 'video', 'document', 'audio'], required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    originalName: { type: String, default: '' },
    storedName: { type: String, required: true }, // file name inside DATA_DIR/uploads
    token: { type: String, required: true, unique: true }, // unguessable, used in the public URL (WhatsApp must be able to fetch it)
  },
  { timestamps: true },
);

schema.index({ ownerId: 1, createdAt: -1 });
schema.index({ ownerId: 1, kind: 1 });

module.exports = mongoose.model('Media', schema);
