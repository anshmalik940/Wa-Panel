const mongoose = require('mongoose');

const { Schema } = mongoose;

/** A caller-ID (CLI) number that outgoing voice calls may present. assignedToId null = usable by everyone. */
const schema = new Schema(
  {
    number: { type: String, required: true, trim: true, unique: true, maxlength: 20 },
    label: { type: String, default: '', trim: true, maxlength: 80 },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    assignedToId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

schema.index({ assignedToId: 1, status: 1 });

module.exports = mongoose.model('CliNumber', schema);
