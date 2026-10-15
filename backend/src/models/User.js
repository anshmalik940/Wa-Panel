const mongoose = require('mongoose');

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 200 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'reseller', 'customer'], required: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    allowQr: { type: Boolean, default: false },
    useOwnQr: { type: Boolean, default: false },
    // customers only: owning reseller (null = managed directly by admin)
    resellerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    companyName: { type: String, trim: true, default: '', maxlength: 160 },
    phone: { type: String, trim: true, default: '', maxlength: 40 },
    // resellers only
    maxCustomers: { type: Number, default: 50, min: 0 },
    // customers only (account limits)
    monthlyMessageLimit: { type: Number, default: 1000, min: 0 },
    contactLimit: { type: Number, default: 5000, min: 0 },
    // prepaid wallet used for real (non-simulated) messages and calls; topped up by the admin (resellers) or the reseller (customers)
    credits: { type: Number, default: 0, min: 0 },
    // session handling: bumping this invalidates every issued token
    tokenVersion: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

userSchema.index({ role: 1, status: 1 });
userSchema.index({ resellerId: 1, createdAt: -1 });
userSchema.index({ role: 1, createdAt: -1 });

userSchema.set('toJSON', {
  transform: (doc, ret) => {
    delete ret.passwordHash;
    delete ret.tokenVersion;
    delete ret.failedLogins;
    delete ret.lockUntil;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
