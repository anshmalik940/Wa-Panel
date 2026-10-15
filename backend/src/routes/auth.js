const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { config } = require('../config');
const { User, PasswordReset } = require('../models');
const { authenticate, signToken } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah } = require('../utils/httpError');
const { randomToken, sha256 } = require('../utils/crypto');
const { sendMail } = require('../utils/mailer');
const { audit } = require('../utils/audit');
const { getSettings } = require('../utils/settings');

const router = express.Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-1', 8);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.RATE_LIMIT_DISABLED,
  message: { error: 'Too many attempts from this address. Please try again in a few minutes.' },
});

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

router.post(
  '/login',
  authLimiter,
  validate(z.object({ email: emailSchema, password: z.string().min(1).max(200) })),
  ah(async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH); // equalise timing: no account enumeration
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.lockUntil && user.lockUntil > new Date()) {
      throw new HttpError(423, `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes or reset your password.`);
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      const failed = (user.failedLogins || 0) + 1;
      const set = failed >= MAX_FAILED ? { failedLogins: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLogins: failed };
      await User.updateOne({ _id: user._id }, { $set: set });
      if (failed >= MAX_FAILED) await audit(null, 'auth.locked', { targetType: 'user', targetId: user._id, ownerId: user.role === 'customer' ? user._id : null, meta: { email } });
      throw new HttpError(401, 'Invalid email or password');
    }
    if (user.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact your administrator.');
    await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockUntil: null, lastLoginAt: new Date() } });
    req.user = user;
    await audit(req, 'auth.login', { targetType: 'user', targetId: user._id, ownerId: user.role === 'customer' ? user._id : null });
    res.json({ token: signToken(user), user });
  }),
);

router.get(
  '/me',
  authenticate,
  ah(async (req, res) => {
    const settings = await getSettings();
    res.json({ user: req.user, brandName: settings.brandName });
  }),
);

router.post(
  '/logout',
  authenticate,
  ah(async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    await audit(req, 'auth.logout', { ownerId: req.user.role === 'customer' ? req.user._id : null });
    res.json({ ok: true });
  }),
);

router.post(
  '/change-password',
  authenticate,
  validate(z.object({ currentPassword: z.string().min(1), newPassword: passwordSchema })),
  ah(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!(await bcrypt.compare(currentPassword, req.user.passwordHash))) throw new HttpError(400, 'Current password is incorrect', [{ field: 'currentPassword', message: 'Incorrect password' }]);
    if (currentPassword === newPassword) throw new HttpError(400, 'New password must be different from the current one');
    const updated = await User.findOneAndUpdate(
      { _id: req.user._id },
      { $set: { passwordHash: await bcrypt.hash(newPassword, config.BCRYPT_ROUNDS) }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    await audit(req, 'auth.password_changed', { targetType: 'user', targetId: updated._id, ownerId: updated.role === 'customer' ? updated._id : null });
    res.json({ token: signToken(updated), user: updated }); // other sessions are now invalid
  }),
);

router.post(
  '/forgot-password',
  authLimiter,
  validate(z.object({ email: emailSchema })),
  ah(async (req, res) => {
    const generic = { message: 'If an account exists for that email, a reset link has been sent.' };
    const user = await User.findOne({ email: req.body.email });
    if (!user || user.status !== 'active') return res.json(generic);
    const token = randomToken(32);
    await PasswordReset.create({ userId: user._id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + config.RESET_TOKEN_TTL_MIN * 60000) });
    const link = `${config.CLIENT_URL.split(',')[0].trim()}/reset-password?token=${token}`;
    const brand = (await getSettings()).brandName;
    try {
      await sendMail({
        to: user.email,
        subject: `${brand}: reset your password`,
        text: `Hello ${user.name},\n\nUse this link to reset your password (valid ${config.RESET_TOKEN_TTL_MIN} minutes):\n${link}\n\nIf you did not request this, ignore this email.`,
      });
    } catch (err) {
      console.error('[mail] password reset email failed', err);
      throw new HttpError(502, 'Could not send the reset email. Please contact your administrator.');
    }
    await audit(null, 'auth.password_reset_requested', { targetType: 'user', targetId: user._id, ownerId: user.role === 'customer' ? user._id : null });
    return res.json(config.RESET_RETURN_LINK ? { ...generic, devResetLink: link } : generic);
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  validate(z.object({ token: z.string().min(20).max(200), password: passwordSchema })),
  ah(async (req, res) => {
    const record = await PasswordReset.findOne({ tokenHash: sha256(req.body.token) });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw new HttpError(400, 'This reset link is invalid or has expired. Request a new one.');
    // single use: claim atomically
    const claimed = await PasswordReset.findOneAndUpdate({ _id: record._id, usedAt: null }, { $set: { usedAt: new Date() } });
    if (!claimed) throw new HttpError(400, 'This reset link has already been used.');
    const user = await User.findOneAndUpdate(
      { _id: record.userId },
      { $set: { passwordHash: await bcrypt.hash(req.body.password, config.BCRYPT_ROUNDS), failedLogins: 0, lockUntil: null }, $inc: { tokenVersion: 1 } },
      { new: true },
    );
    await audit(null, 'auth.password_reset_completed', { targetType: 'user', targetId: user._id, ownerId: user.role === 'customer' ? user._id : null });
    res.json({ ok: true, message: 'Password updated. You can sign in now.' });
  }),
);

module.exports = router;
module.exports.passwordSchema = passwordSchema;
module.exports.emailSchema = emailSchema;
