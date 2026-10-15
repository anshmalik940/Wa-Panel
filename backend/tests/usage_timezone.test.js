process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/wa_usage_unit_test';
process.env.JWT_SECRET = 'usage-test-secret'.padEnd(40, 'x');
process.env.ENCRYPTION_KEY = 'usage-test-encryption'.padEnd(40, 'x');
process.env.USAGE_TIMEZONE = 'Asia/Kolkata';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { periodOf, periodStart, periodBounds } = require('../src/services/usage');

test('usage month changes at midnight in the configured timezone', () => {
  assert.equal(periodOf(new Date('2026-09-30T18:29:59.999Z')), '2026-09');
  assert.equal(periodOf(new Date('2026-09-30T18:30:00.000Z')), '2026-10');
  assert.equal(periodStart('2026-10').toISOString(), '2026-09-30T18:30:00.000Z');
  const { start, end } = periodBounds('2026-10');
  assert.equal(start.toISOString(), '2026-09-30T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-10-31T18:30:00.000Z');
});
