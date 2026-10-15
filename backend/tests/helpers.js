const crypto = require('crypto');

const BASE = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB = `wa_test_${crypto.randomBytes(4).toString('hex')}`;
const defaults = {
  NODE_ENV: 'test',
  MONGODB_URI: `${BASE}/${DB}`,
  JWT_SECRET: 't'.repeat(40),
  ENCRYPTION_KEY: 'e'.repeat(40),
  ADMIN_EMAIL: 'admin@test.local',
  ADMIN_PASSWORD: 'Admin@12345',
  BCRYPT_ROUNDS: '4',
  WORKER_ENABLED: 'false',
  WORKER_BATCH_SIZE: '4',
  RATE_LIMIT_DISABLED: 'true',
  ALLOW_REAL_SEND: 'true', // tests must not depend on a developer's local .env; tests that need it off flip config at runtime
  DEFAULT_COUNTRY_CODE: '91',
  PUBLIC_API_URL: 'http://localhost:5000',
};
for (const [k, v] of Object.entries(defaults)) if (process.env[k] === undefined || k === 'MONGODB_URI') process.env[k] = k === 'MONGODB_URI' ? defaults[k] : v;

const assert = require('node:assert/strict');
const supertest = require('supertest');
const { connectDb, disconnectDb, mongoose } = require('../src/db');
const { createApp } = require('../src/app');
const { bootstrapAdmin } = require('../src/services/bootstrap');
const { tick } = require('../src/services/queue');
const { CampaignMessage } = require('../src/models');

const silent = { log() {}, warn() {} };
const rand = () => crypto.randomBytes(4).toString('hex');
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!';

let server = null;

async function setup() {
  await connectDb(process.env.MONGODB_URI);
  await bootstrapAdmin(silent);
  const app = createApp();
  server = app.listen(0, '127.0.0.1'); // one persistent server: avoids per-request ephemeral servers
  await new Promise((resolve) => server.once('listening', resolve));
  return { app, http: supertest(server) };
}

async function teardown() {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = null;
  await mongoose.connection.dropDatabase();
  await disconnectDb();
}

async function login(http, email, password = PASSWORD) {
  const r = await http.post('/api/auth/login').send({ email, password });
  assert.equal(r.status, 200, `login failed for ${email}: ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const adminLogin = (http) => login(http, 'admin@test.local', 'Admin@12345');

async function makeReseller(http, adminToken, over = {}) {
  const email = over.email || `reseller_${rand()}@t.local`;
  const r = await http.post('/api/admin/resellers').set(auth(adminToken)).send({ name: 'Test Reseller', email, password: PASSWORD, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.reseller._id, email, token: await login(http, email) };
}

async function makeCustomer(http, creatorToken, { base = '/api/admin/customers', ...over } = {}) {
  const email = over.email || `customer_${rand()}@t.local`;
  const r = await http.post(base).set(auth(creatorToken)).send({ name: 'Test Customer', email, password: PASSWORD, ...over });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.customer._id, email, token: await login(http, email) };
}

async function fastMock(http, adminToken) {
  const r = await http.put('/api/admin/settings').set(auth(adminToken)).send({ mockDeliveryDelayMs: 0, mockReadDelayMs: 0, mockFailureRate: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function connectMock(http, token) {
  let r = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'mock' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await http.post('/api/c/whatsapp/connect').set(auth(token));
  assert.equal(r.body.account.status, 'connected');
}

async function approvedTemplate(http, token, over = {}) {
  const payload = { name: `tpl_${rand()}`, language: 'en', category: 'MARKETING', header: '', body: 'Hi {{first_name}}, our sale is on!', footer: '', ...over };
  let r = await http.post('/api/c/templates').set(auth(token)).send(payload);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.template._id;
  r = await http.post(`/api/c/templates/${id}/submit`).set(auth(token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await http.post('/api/c/templates/sync').set(auth(token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return id;
}

/** Imports n valid contacts (+91 90000 00100...). Returns the import report. */
async function addContacts(http, token, n, { group = '', namePrefix = 'Person' } = {}) {
  const lines = ['name,phone,email,group'];
  for (let i = 0; i < n; i += 1) lines.push(`${namePrefix} ${i} Lastname,${9000000100 + i},p${i}_${rand()}@x.com,${group}`);
  const r = await http.post('/api/c/contacts/import').set(auth(token)).send({ csv: lines.join('\n') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, n);
  return r.body;
}

async function newTenant(http, { contacts = 0, connect = true, limits = {} } = {}) {
  const adminToken = await adminLogin(http);
  await fastMock(http, adminToken);
  const customer = await makeCustomer(http, adminToken, limits);
  if (connect) await connectMock(http, customer.token);
  if (contacts) await addContacts(http, customer.token, contacts);
  return { adminToken, customer, token: customer.token };
}

async function createCampaign(http, token, templateId, over = {}) {
  const r = await http.post('/api/c/campaigns').set(auth(token)).send({
    name: `Campaign ${rand()}`,
    templateId,
    audience: { mode: 'all' },
    variableMap: { first_name: { source: 'field', field: 'first_name', fallback: 'there' } },
    ...over,
  });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body.campaign;
}

/** Runs worker passes until nothing is queued/sending (for one campaign, or globally). */
async function drain(campaignId, maxTicks = 60) {
  const filter = { status: { $in: ['queued', 'sending'] } };
  if (campaignId) filter.campaignId = campaignId;
  for (let i = 0; i < maxTicks; i += 1) {
    await tick();
    if ((await CampaignMessage.countDocuments(filter)) === 0) return i + 1;
  }
  throw new Error('queue did not drain');
}

module.exports = { assert, setup, teardown, login, adminLogin, makeReseller, makeCustomer, fastMock, connectMock, approvedTemplate, addContacts, newTenant, createCampaign, drain, auth, rand, PASSWORD, mongoose };
