const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { User } = require('../models');
const { emailSchema, passwordSchema } = require('../routes/auth');

async function resetAdminCredentials({ currentEmail, newEmail = currentEmail, password }, UserModel = User) {
  const currentEmailResult = emailSchema.safeParse(currentEmail);
  const newEmailResult = emailSchema.safeParse(newEmail);
  const passwordResult = passwordSchema.safeParse(password);
  if (!currentEmailResult.success || !newEmailResult.success || !passwordResult.success) {
    throw new Error('Enter valid admin email addresses and a password meeting the application password rules.');
  }

  const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS);
  const updated = await UserModel.findOneAndUpdate(
    { role: 'admin', email: currentEmailResult.data },
    {
      $set: {
        email: newEmailResult.data,
        passwordHash,
        failedLogins: 0,
        lockUntil: null,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true, runValidators: true },
  );
  if (!updated) throw new Error('No existing admin account matched the supplied current email. No account was created or changed.');
  return true;
}

module.exports = { resetAdminCredentials };
