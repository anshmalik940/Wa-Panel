const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { User, WhatsAppAccount } = require('../models');
const { passwordSchema } = require('../routes/auth');
const wa = require('./waSession');
const { encrypt, decrypt } = require('../utils/crypto');

async function migrateLegacyQrPermissions() {
  const accounts = await WhatsAppAccount.find({ verifyToken: { $ne: '' } }).select('_id verifyToken');
  for (const account of accounts) {
    try {
      decrypt(account.verifyToken);
    } catch {
      await WhatsAppAccount.updateOne({ _id: account._id }, { $set: { verifyToken: encrypt(account.verifyToken) } });
    }
  }
  const legacyQrIds = new Set(
    (await WhatsAppAccount.find({ provider: 'qr' }).select('ownerId').lean()).map((account) => String(account.ownerId)),
  );
  const users = await User.find({ role: { $in: ['customer', 'reseller'] } }).select('_id');
  for (const user of users) {
    if (legacyQrIds.has(String(user._id)) || wa.hasSavedSession(user._id)) {
      await User.updateOne({ _id: user._id }, { $set: { allowQr: true, useOwnQr: true } });
    }
  }
}

/** Creates the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD when no admin exists yet. */
async function bootstrapAdmin(log = console) {
  let created = false;
  let missingConfig = false;
  if (!(await User.exists({ role: 'admin' }))) {
    if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) {
      log.warn('[bootstrap] No admin account exists. Set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart (or run "npm run seed").');
      missingConfig = true;
    } else {
      const check = passwordSchema.safeParse(config.ADMIN_PASSWORD);
      if (!check.success) throw new Error(`ADMIN_PASSWORD rejected: ${check.error.issues.map((i) => i.message).join('; ')}`);
      await User.create({
        role: 'admin',
        name: config.ADMIN_NAME,
        email: config.ADMIN_EMAIL.toLowerCase(),
        passwordHash: await bcrypt.hash(config.ADMIN_PASSWORD, config.BCRYPT_ROUNDS),
      });
      log.log(`[bootstrap] Admin account created: ${config.ADMIN_EMAIL}`);
      created = true;
    }
  }
  await migrateLegacyQrPermissions();
  return { created, ...(missingConfig ? { missingConfig: true } : {}) };
}

module.exports = { bootstrapAdmin, migrateLegacyQrPermissions };
