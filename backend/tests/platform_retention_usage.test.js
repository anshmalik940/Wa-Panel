const { before, after, test } = require('node:test');
const h = require('./helpers');
const {
  User,
  Campaign,
  CampaignMessage,
  CampaignArchive,
  Usage,
  MonthlyUsageSummary,
  CreditTransaction,
  WhatsappApiConfig,
} = require('../src/models');
const { ObjectId } = require('mongoose').Types;
const { updateSettings } = require('../src/utils/settings');
const { cleanupOwner } = require('../src/services/campaignRetention');
const { periodOf, shiftPeriod, finalizeMonthlySummary, getUsage } = require('../src/services/usage');
const credits = require('../src/services/credits');

const { assert, auth } = h;
let http;
let adminToken;

before(async () => {
  ({ http } = await h.setup());
  adminToken = await h.adminLogin(http);
});

after(h.teardown);

test('platform connection secrets stay masked and workspace users cannot change QR permission', async () => {
  const customer = await h.makeCustomer(http, adminToken);
  const apiKey = 'platform-key-' + 'a'.repeat(30);
  const accessToken = 'platform-token-' + 'b'.repeat(30);
  const saved = await http.put('/api/admin/wa-api').set(auth(adminToken)).send({
    activeProvider: 'wa_http',
    mode: 'http',
    baseUrl: 'https://vendor.example/send',
    apiKey,
    meta: { phoneNumberId: '123456789', wabaId: '987654321', accessToken, appSecret: 'app-secret', verifyToken: 'verify-secret' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.config.hasApiKey, true);
  assert.equal(saved.body.config.meta.hasAccessToken, true);
  assert.ok(!JSON.stringify(saved.body).includes(apiKey));
  assert.ok(!JSON.stringify(saved.body).includes(accessToken));
  assert.ok(!JSON.stringify(saved.body).includes('app-secret'));
  assert.ok(!JSON.stringify(saved.body).includes('verify-secret'));

  const stored = await WhatsappApiConfig.findOne({ key: 'default' }).lean();
  assert.notEqual(stored.apiKeyEnc, apiKey);
  assert.notEqual(stored.meta.accessTokenEnc, accessToken);
  const workspace = await http.get('/api/c/whatsapp').set(auth(customer.token));
  assert.equal(workspace.status, 200);
  assert.equal(workspace.body.allowQr, false);
  assert.equal(workspace.body.connection.source, 'platform');
  assert.ok(!JSON.stringify(workspace.body).includes(apiKey));
  assert.ok(!JSON.stringify(workspace.body).includes(accessToken));
  assert.equal(Object.hasOwn(workspace.body, 'account'), false);
  assert.equal((await http.get('/api/admin/wa-api').set(auth(customer.token))).status, 403);
  assert.equal((await http.put('/api/c/whatsapp').set(auth(customer.token)).send({ allowQr: true })).status, 403);
});

test('legacy QR permission migration enables existing QR accounts without touching session directories', async () => {
  const customer = await h.makeCustomer(http, adminToken);
  const { WhatsAppAccount } = require('../src/models');
  await WhatsAppAccount.create({ ownerId: customer.id, provider: 'qr', verifyToken: 'legacy-qr-token' });
  const { migrateLegacyQrPermissions } = require('../src/services/bootstrap');
  await migrateLegacyQrPermissions();
  const migrated = await User.findById(customer.id).select('allowQr useOwnQr').lean();
  assert.deepEqual({ allowQr: migrated.allowQr, useOwnQr: migrated.useOwnQr }, { allowQr: true, useOwnQr: true });
  const account = await WhatsAppAccount.findOne({ ownerId: customer.id }).lean();
  assert.notEqual(account.verifyToken, 'legacy-qr-token');
});

test('retention removes only excess finished campaigns and message rows, preserves aggregates, and honors changed limits', async () => {
  const ownerA = await h.makeCustomer(http, adminToken);
  const ownerB = await h.makeCustomer(http, adminToken);
  await updateSettings({ finishedCampaignRetentionLimit: 10 });
  const oldIds = [];
  const templateId = new ObjectId();
  for (let i = 0; i < 12; i += 1) {
    const campaign = await Campaign.create({
      ownerId: ownerA.id,
      name: `Finished ${i}`,
      templateId,
      submissionKey: `retention-${i}-${Date.now()}`,
      status: 'completed',
      createdAt: new Date(Date.now() - (12 - i) * 60000),
    });
    oldIds.push(campaign._id);
    await CampaignMessage.create({
      campaignId: campaign._id,
      ownerId: ownerA.id,
      contactId: new ObjectId(),
      phone: `+9198765432${String(i).padStart(2, '0')}`,
      status: 'sent',
    });
  }
  const retained = await Campaign.create({
    ownerId: ownerA.id,
    name: 'Running',
    templateId,
    submissionKey: `retention-running-${Date.now()}`,
    status: 'running',
  });
  const scheduled = await Campaign.create({
    ownerId: ownerA.id,
    name: 'Scheduled',
    templateId,
    submissionKey: `retention-scheduled-${Date.now()}`,
    status: 'scheduled',
  });
  const otherOwnerCampaign = await Campaign.create({
    ownerId: ownerB.id,
    name: 'Other owner',
    templateId,
    submissionKey: `retention-other-${Date.now()}`,
    status: 'completed',
  });
  const currentPeriod = periodOf();
  await Usage.create({ ownerId: ownerA.id, period: currentPeriod, messages: 6, messagesSent: 6, countersVersion: 1 });
  await CreditTransaction.create({
    userId: ownerA.id,
    type: 'debit',
    amount: 6,
    balanceAfter: 0,
    reason: 'campaign',
    campaignId: oldIds[0],
  });

  assert.equal(await cleanupOwner(ownerA.id), 2);
  assert.equal(await Campaign.countDocuments({ ownerId: ownerA.id, status: 'completed' }), 10);
  assert.equal(await CampaignMessage.countDocuments({ campaignId: { $in: oldIds.slice(0, 2) } }), 0);
  assert.equal(await CampaignMessage.countDocuments({ campaignId: { $in: oldIds.slice(2) } }), 10);
  assert.ok(await Campaign.exists({ _id: retained._id }));
  assert.ok(await Campaign.exists({ _id: scheduled._id }));
  assert.ok(await Campaign.exists({ _id: otherOwnerCampaign._id }));
  assert.equal(await CampaignArchive.countDocuments({ ownerId: ownerA.id }), 2);
  assert.equal((await Usage.findOne({ ownerId: ownerA.id, period: currentPeriod })).messages, 6);
  assert.equal(await CreditTransaction.countDocuments({ userId: ownerA.id }), 1);
  assert.equal(await cleanupOwner(ownerA.id), 0);

  await updateSettings({ finishedCampaignRetentionLimit: 1 });
  assert.equal(await cleanupOwner(ownerA.id), 9);
  assert.equal(await Campaign.countDocuments({ ownerId: ownerA.id, status: 'completed' }), 1);
  assert.equal(await CreditTransaction.countDocuments({ userId: ownerA.id }), 1);
});

test('monthly usage summary is idempotent and refund adjustments produce net credits spent', async () => {
  const customer = await h.makeCustomer(http, adminToken);
  const period = shiftPeriod(periodOf(), -1);
  await Usage.create({
    ownerId: customer.id,
    period,
    messages: 9,
    simulatedMessages: 2,
    campaignsStarted: 3,
    messagesSent: 7,
    messagesFailed: 1,
    creditsSpent: 14,
    voiceCalls: 2,
    countersVersion: 1,
  });
  const first = await finalizeMonthlySummary(customer.id, period);
  const second = await finalizeMonthlySummary(customer.id, period);
  assert.equal(String(first._id), String(second._id));
  assert.equal(second.totals.creditsSpent, 14);
  assert.equal(second.totals.messagesFailed, 1);
  await Usage.updateOne({ ownerId: customer.id, period }, { $set: { creditsSpent: 1 } });
  assert.equal((await finalizeMonthlySummary(customer.id, period)).totals.creditsSpent, 14);
  assert.equal(await MonthlyUsageSummary.countDocuments({ ownerId: customer.id, period }), 1);

  await User.updateOne({ _id: customer.id }, { $set: { credits: 20 } });
  const campaignId = new ObjectId();
  assert.equal(await credits.charge(customer.id, 7, campaignId), true);
  await credits.refund(customer.id, 3, campaignId);
  assert.equal(await CreditTransaction.countDocuments({ userId: customer.id, campaignId }), 2);
  assert.equal(await CreditTransaction.countDocuments({ userId: customer.id, campaignId, reason: 'campaign' }), 1);
  assert.equal(await CreditTransaction.countDocuments({ userId: customer.id, campaignId, reason: 'refund' }), 1);
  const usage = await getUsage(customer.id, periodOf());
  assert.equal(usage.creditsSpent, 4);
  assert.equal((await User.findById(customer.id)).credits, 16);
  assert.equal((await http.get('/api/c/usage').query({ period: '2026-13' }).set(auth(customer.token))).status, 400);
  assert.equal((await http.get('/api/c/usage').query({ period: shiftPeriod(periodOf(), 1) }).set(auth(customer.token))).status, 400);
  const selected = await http.get('/api/c/usage').query({ period }).set(auth(customer.token));
  assert.equal(selected.status, 200);
  assert.equal(selected.body.period, period);
});
