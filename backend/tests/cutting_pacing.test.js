require('./helpers');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { shouldPauseForProviderError } = require('../src/services/queue');
const { getCampaignReport } = require('../src/services/campaignService');
const { Campaign, CampaignMessage, Contact, CreditTransaction, User } = require('../src/models');
const { setup, teardown, adminLogin, makeCustomer, auth, rand } = require('./helpers');
const credits = require('../src/services/credits');

describe('campaign cutting and queue safety', () => {
  test('provider safety errors trigger a pause', () => {
    assert.equal(shouldPauseForProviderError({ status: 429 }), true);
    assert.equal(shouldPauseForProviderError({ code: '190', status: 400 }), true);
    assert.equal(shouldPauseForProviderError({ code: 'NETWORK', status: 0, message: 'provider outcome unknown' }), true);
    assert.equal(shouldPauseForProviderError({ status: 503 }), true);
  });

  test('admin-only cutting lifecycle, full charges, and report status integrity', async () => {
    const { http } = await setup();
    try {
      const adminToken = await adminLogin(http);
      const customer = await makeCustomer(http, adminToken);
      const payload = {
        percentage: 10,
        startsAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: null,
        active: true,
        internalReason: 'delivery cutting test',
      };
      let response = await http.put(`/api/admin/cutting/${customer.id}`).set(auth(adminToken)).send(payload);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      response = await http.get('/api/c/credits').set(auth(customer.token));
      assert.equal(response.status, 200);
      assert.equal(response.body.cutting.eligible, true);
      assert.equal(Object.hasOwn(response.body.cutting, 'internalReason'), false);
      response = await http.put(`/api/admin/cutting/${customer.id}`).set(auth(customer.token)).send(payload);
      assert.equal(response.status, 403);
      response = await http.get(`/api/admin/cutting/${customer.id}/history`).set(auth(adminToken));
      assert.equal(response.status, 200);
      assert.ok(response.body.data.some((event) => event.action === 'cutting.create'));

      response = await http.post(`/api/admin/cutting/${customer.id}/revoke`).set(auth(adminToken));
      assert.equal(response.status, 200);
      assert.equal(response.body.cutting.active, false);
      response = await http.get('/api/c/credits').set(auth(customer.token));
      assert.equal(response.body.cutting.eligible, false);

      await User.updateOne({ _id: customer.id }, { $set: { credits: 50 } });
      const campaign = await Campaign.create({
        ownerId: customer.id,
        name: `cut billing ${rand()}`,
        channel: 'voice',
        provider: 'voice_http',
        submissionKey: rand(),
        cuttingPercentage: 10,
      });
      const contact = await Contact.create({ ownerId: customer.id, name: 'Cut report contact', phone: `+9190000${String(Date.now()).slice(-5)}` });
      const sentContact = await Contact.create({ ownerId: customer.id, name: 'Sent report contact', phone: `+9180000${String(Date.now()).slice(-5)}` });
      const cutMessage = await CampaignMessage.create({
        campaignId: campaign._id, ownerId: customer.id, contactId: contact._id, phone: contact.phone,
        status: 'cut', isCut: true, cuttingPercentage: 10, cutAt: new Date(),
        billing: { originalCharge: 10, finalCharge: 10, appliedAt: new Date() },
      });
      await CampaignMessage.create({
        campaignId: campaign._id, ownerId: customer.id, contactId: sentContact._id, phone: sentContact.phone,
        status: 'delivered', sentAt: new Date(), deliveredAt: new Date(),
        billing: { originalCharge: 10, finalCharge: 10, appliedAt: new Date() },
      });
      assert.equal(await credits.charge(customer.id, 10, campaign._id, { originalCharge: 10 }), true);
      const ledger = await CreditTransaction.findOne({ userId: customer.id, campaignId: campaign._id, reason: 'campaign' }).lean();
      assert.equal(ledger.amount, 10);
      assert.equal(ledger.originalAmount, 10);
      assert.equal((await User.findById(customer.id)).credits, 40);

      const report = await getCampaignReport(campaign);
      assert.equal(report.stats.cut, 1);
      assert.equal(report.stats.delivered, 1);
      assert.equal(report.stats.sent, 1);
      assert.deepEqual(report.billing, { messages: 2, cutMessages: 1, originalCharge: 20, finalCharge: 20 });
      assert.equal(cutMessage.status, 'cut');
    } finally {
      await teardown();
    }
  });
});
