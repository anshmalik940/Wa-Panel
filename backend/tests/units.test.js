require('./helpers');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone } = require('../src/utils/phone');
const { parseCSV, toCSV } = require('../src/utils/csv');
const { extractVars, render, validateTemplateFields } = require('../src/utils/template');
const { encrypt, decrypt } = require('../src/utils/crypto');
const { loadConfig } = require('../src/config');
const { evaluateRecipient } = require('../src/services/campaignService');
const CreditTransaction = require('../src/models/CreditTransaction');

describe('phone normalisation', () => {
  test('local 10 digit numbers get the default country code', () => {
    assert.deepEqual(normalizePhone('98765 43210', '91'), { phone: '+919876543210', valid: true });
    assert.deepEqual(normalizePhone('(098765) 43210', '91'), { phone: '+919876543210', valid: true });
  });
  test('international formats are kept', () => {
    assert.deepEqual(normalizePhone('+1 (415) 555-2671', '91'), { phone: '+14155552671', valid: true });
    assert.deepEqual(normalizePhone('0014155552671', '91'), { phone: '+14155552671', valid: true });
  });
  test('garbage is flagged invalid, never silently fixed', () => {
    assert.equal(normalizePhone('12345', '91').valid, false);
    assert.equal(normalizePhone('call me', '91').valid, false);
    assert.equal(normalizePhone('', '91').valid, false);
    assert.equal(normalizePhone('+0123456789', '91').valid, false);
  });
});

describe('csv', () => {
  test('parses quotes, escaped quotes, CRLF, BOM and semicolons', () => {
    const rows = parseCSV('﻿name;phone\r\n"Doe; John";"+91 98765 43210"\r\n"He said ""hi""";123\r\n');
    assert.deepEqual(rows, [['name', 'phone'], ['Doe; John', '+91 98765 43210'], ['He said "hi"', '123']]);
  });
  test('export neutralises formula injection but keeps phone numbers intact', () => {
    const out = toCSV([['=HYPERLINK("x")', '+919876543210', '-cmd', '@SUM(1)', 'a,b']]);
    assert.equal(out.trim(), `"'=HYPERLINK(""x"")",+919876543210,'-cmd,'@SUM(1),"a,b"`);
  });
});

describe('templates', () => {
  test('extracts and renders placeholders', () => {
    assert.deepEqual(extractVars('Hi {{ First_Name }}, {{city}} {{first_name}}'), ['first_name', 'city']);
    assert.equal(render('Hi {{first_name}} from {{city}}', { first_name: 'Asha', city: 'Delhi' }), 'Hi Asha from Delhi');
  });
  test('validation rules', () => {
    const ok = { name: 'welcome_1', language: 'en', category: 'MARKETING', body: 'Hello {{name}}!' };
    assert.equal(validateTemplateFields(ok).length, 0);
    assert.ok(validateTemplateFields({ ...ok, name: 'Bad Name' }).some((e) => e.field === 'name'));
    assert.ok(validateTemplateFields({ ...ok, body: 'Hi {{name' }).some((e) => e.field === 'body'));
    assert.ok(validateTemplateFields({ ...ok, header: 'Hi {{name}}' }).some((e) => e.field === 'header'));
    assert.ok(validateTemplateFields({ ...ok, body: 'x'.repeat(1025) }).some((e) => e.field === 'body'));
    assert.ok(validateTemplateFields({ ...ok, category: 'NOPE' }).some((e) => e.field === 'category'));
    assert.equal(validateTemplateFields({ ...ok, body: '', attachmentType: 'image', mediaId: 'uploaded-media' }).some((e) => e.field === 'body'), false);
    assert.equal(validateTemplateFields({ ...ok, body: '', attachmentType: 'none' }).some((e) => e.field === 'body'), true);
    assert.equal(validateTemplateFields({ ...ok, body: '', headerType: 'image', mediaId: 'uploaded-media' }).some((e) => e.field === 'body'), false);
  });
});

describe('recipient evaluation', () => {
  const snap = { header: '', body: 'Hi {{first_name}} {{promo}}', footer: '', variables: ['first_name', 'promo'] };
  const map = { first_name: { source: 'field', field: 'first_name', fallback: 'there' }, promo: { source: 'fixed', value: '10% off' } };
  test('renders personalisation, fallback and fixed values', () => {
    const r = evaluateRecipient({ name: 'Asha Rao', phone: '+919876543210', phoneValid: true }, snap, map);
    assert.equal(r.text, 'Hi Asha 10% off');
    assert.equal(evaluateRecipient({ name: '', phone: '+919876543210', phoneValid: true }, snap, map).text, 'Hi there 10% off');
  });
  test('excludes opted-out, invalid and missing-data contacts', () => {
    assert.equal(evaluateRecipient({ optedOut: true, phoneValid: true }, snap, map).reason, 'opted_out');
    assert.equal(evaluateRecipient({ optedOut: false, phoneValid: false }, snap, map).reason, 'invalid_phone');
    const strict = { ...map, first_name: { source: 'field', field: 'first_name' } };
    assert.equal(evaluateRecipient({ name: '', phoneValid: true }, snap, strict).reason, 'missing_variable:first_name');
  });
});

describe('crypto + config', () => {
  test('credentials round-trip and are not stored in clear', () => {
    const enc = encrypt('EAAB-secret-token');
    assert.ok(!enc.includes('EAAB'));
    assert.equal(decrypt(enc), 'EAAB-secret-token');
  });

  describe('credit transaction indexes', () => {
    test('campaign uniqueness index only includes non-null campaign IDs', () => {
      const [, options] = CreditTransaction.schema.indexes().find(([keys]) => (
        keys.userId === 1 && keys.campaignId === 1 && keys.reason === 1
      ));
      assert.equal(options.name, 'user_campaign_reason_nonnull_unique');
      assert.deepEqual(options.partialFilterExpression, { campaignId: { $type: 'objectId' } });
    });
  });
  test('environment validation fails fast with readable messages', () => {
    assert.throws(() => loadConfig({}), /MONGODB_URI is required[\s\S]*JWT_SECRET/);
    assert.throws(() => loadConfig({ MONGODB_URI: 'x', JWT_SECRET: 'short', ENCRYPTION_KEY: 'k'.repeat(40) }), /JWT_SECRET must be at least 32/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', MONGODB_URI: 'x', JWT_SECRET: 'change-me-'.repeat(5), ENCRYPTION_KEY: 'k'.repeat(40) }), /example value/);
    const ok = loadConfig({ MONGODB_URI: 'x', JWT_SECRET: 'j'.repeat(32), ENCRYPTION_KEY: 'k'.repeat(32) });
    assert.equal(ok.ALLOW_REAL_SEND, true);
    assert.equal(loadConfig({ MONGODB_URI: 'x', JWT_SECRET: 'j'.repeat(32), ENCRYPTION_KEY: 'k'.repeat(32), ALLOW_REAL_SEND: 'false' }).ALLOW_REAL_SEND, false);
  });
});
