process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/wa_panel_admin_reset_test';
process.env.JWT_SECRET = 'admin-reset-test-jwt-secret-long-enough';
process.env.ENCRYPTION_KEY = 'admin-reset-test-encryption-key-long-enough';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { resetAdminCredentials } = require('../src/services/adminCredentialReset');

test('admin reset updates only an existing admin and stores a bcrypt hash', async () => {
  let query;
  let update;
  let options;
  const userModel = {
    async findOneAndUpdate(filter, changes, settings) {
      query = filter;
      update = changes;
      options = settings;
      return { role: 'admin' };
    },
  };

  const changed = await resetAdminCredentials({
    currentEmail: ' ADMIN@EXAMPLE.COM ',
    newEmail: 'new-admin@example.com',
    password: 'Stronger-test-password-583!',
  }, userModel);

  assert.equal(changed, true);
  assert.deepEqual(query, { role: 'admin', email: 'admin@example.com' });
  assert.equal(update.$set.email, 'new-admin@example.com');
  assert.equal(update.$set.failedLogins, 0);
  assert.equal(update.$set.lockUntil, null);
  assert.equal(update.$inc.tokenVersion, 1);
  assert.equal(await bcrypt.compare('Stronger-test-password-583!', update.$set.passwordHash), true);
  assert.notEqual(update.$set.passwordHash, 'Stronger-test-password-583!');
  assert.deepEqual(options, { new: true, runValidators: true });
});

test('admin reset refuses to create an account when no existing admin matches', async () => {
  const userModel = { async findOneAndUpdate() { return null; } };
  await assert.rejects(
    resetAdminCredentials({
      currentEmail: 'missing@example.com',
      password: 'Stronger-test-password-583!',
    }, userModel),
    /No existing admin account matched/,
  );
});

test('admin reset rejects passwords that fail existing application rules', async () => {
  let called = false;
  const userModel = { async findOneAndUpdate() { called = true; return { role: 'admin' }; } };
  await assert.rejects(
    resetAdminCredentials({ currentEmail: 'admin@example.com', password: 'short' }, userModel),
    /password meeting the application password rules/,
  );
  assert.equal(called, false);
});
