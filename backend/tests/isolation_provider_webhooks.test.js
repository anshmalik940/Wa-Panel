const crypto = require('crypto');
const { test, describe, before, after, afterEach } = require('node:test');
const h = require('./helpers');
const { CampaignMessage, Contact, Template, WebhookEvent } = require('../src/models');

const { assert, auth } = h;
let http;

before(async () => {
  ({ http } = await h.setup());
});
after(h.teardown);

describe('workflow 9: tenant isolation', () => {
  test('a customer can never read or change another customer\'s data', async () => {
    const A = await h.newTenant(http, { contacts: 4 });
    const B = await h.newTenant(http, { contacts: 2 });
    const tplA = await h.approvedTemplate(http, A.token);
    const campA = await h.createCampaign(http, A.token, tplA);
    await http.post(`/api/c/campaigns/${campA._id}/start`).set(auth(A.token));
    await h.drain(campA._id);
    const contactA = (await http.get('/api/c/contacts').set(auth(A.token))).body.data[0];

    // B's lists never include A's rows
    assert.equal((await http.get('/api/c/contacts').set(auth(B.token))).body.total, 2);
    assert.equal((await http.get('/api/c/campaigns').set(auth(B.token))).body.total, 0);
    assert.equal((await http.get('/api/c/templates').set(auth(B.token))).body.total, 0);

    // direct id access is a 404 (not 403: ids must not even be confirmed to exist)
    const probes = [
      ['get', `/api/c/contacts/${contactA._id}`],
      ['patch', `/api/c/contacts/${contactA._id}`, { name: 'hijack' }],
      ['delete', `/api/c/contacts/${contactA._id}`],
      ['get', `/api/c/templates/${tplA}`],
      ['put', `/api/c/templates/${tplA}`, { name: 'hijack_tpl', language: 'en', category: 'MARKETING', body: 'x' }],
      ['delete', `/api/c/templates/${tplA}`],
      ['post', `/api/c/templates/${tplA}/submit`],
      ['get', `/api/c/campaigns/${campA._id}`],
      ['patch', `/api/c/campaigns/${campA._id}`, { name: 'hijack' }],
      ['get', `/api/c/campaigns/${campA._id}/messages`],
      ['get', `/api/c/campaigns/${campA._id}/export`],
      ['post', `/api/c/campaigns/${campA._id}/start`],
      ['post', `/api/c/campaigns/${campA._id}/cancel`],
      ['post', `/api/c/campaigns/${campA._id}/pause`],
      ['post', `/api/c/campaigns/${campA._id}/clone`],
      ['delete', `/api/c/campaigns/${campA._id}`],
    ];
    for (const [method, url, body] of probes) {
      const r = await http[method](url).set(auth(B.token)).send(body);
      assert.ok([404, 409].includes(r.status) && r.status !== 200, `${method.toUpperCase()} ${url} leaked: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
      assert.equal(r.status, 404, `${method.toUpperCase()} ${url} should be 404, got ${r.status}`);
    }
    // A's data is untouched
    assert.equal((await http.get(`/api/c/contacts/${contactA._id}`).set(auth(A.token))).body.contact.name, contactA.name);
    assert.equal((await http.get(`/api/c/campaigns/${campA._id}`).set(auth(A.token))).body.campaign.status, 'completed');

    // B cannot aim a campaign at A's contacts or template
    const tplB = await h.approvedTemplate(http, B.token);
    const crossContacts = await http.post('/api/c/campaigns').set(auth(B.token)).send({ name: 'x', templateId: tplB, audience: { mode: 'contacts', contactIds: [contactA._id] }, variableMap: {} });
    assert.equal(crossContacts.status, 400);
    const crossTpl = await http.post('/api/c/campaigns').set(auth(B.token)).send({ name: 'x', templateId: tplA, audience: { mode: 'all' }, variableMap: {} });
    assert.equal(crossTpl.status, 404);
    // bulk and merge with A's ids affect nothing
    const bulk = await http.post('/api/c/contacts/bulk').set(auth(B.token)).send({ action: 'delete', ids: [contactA._id] });
    assert.equal(bulk.body.affected, 0);
    assert.equal(await Contact.countDocuments({ _id: contactA._id }), 1);
    const merge = await http.post('/api/c/contacts/merge').set(auth(B.token)).send({ keepId: contactA._id, mergeIds: [(await http.get('/api/c/contacts').set(auth(B.token))).body.data[0]._id] });
    assert.equal(merge.status, 404);

    // settings, usage, dashboard, audit are per tenant
    const dashB = (await http.get('/api/c/dashboard').set(auth(B.token))).body;
    assert.equal(dashB.contacts.total, 2);
    assert.equal(dashB.messagesLast30Days.sent, 0);
    assert.equal((await http.get('/api/c/usage').set(auth(B.token))).body.messages.used, 0);
    const auditB = (await http.get('/api/c/audit').set(auth(B.token))).body.data;
    assert.ok(auditB.length > 0);
    assert.ok(!auditB.some((e) => e.targetId === String(campA._id)), 'audit trail must not leak other tenants');
    const waA = (await http.get('/api/c/whatsapp').set(auth(A.token))).body.account;
    const waB = (await http.get('/api/c/whatsapp').set(auth(B.token))).body.account;
    assert.notEqual(waA.verifyToken, waB.verifyToken);
  });

  test('resellers see only their customers; customers cannot reach admin or reseller APIs', async () => {
    const adminToken = await h.adminLogin(http);
    const r1 = await h.makeReseller(http, adminToken);
    const r2 = await h.makeReseller(http, adminToken);
    const c1 = await h.makeCustomer(http, r1.token, { base: '/api/reseller/customers' });
    for (const [method, url] of [
      ['get', `/api/reseller/customers/${c1.id}`],
      ['post', `/api/reseller/customers/${c1.id}/activate`],
      ['post', `/api/reseller/customers/${c1.id}/reset-password`],
    ]) {
      assert.equal((await http[method](url).set(auth(r2.token)).send({ password: 'Fresh12345' })).status, 404, `${method} ${url}`);
    }
    // reseller cannot use admin endpoints to escape their scope
    assert.equal((await http.get('/api/admin/customers').set(auth(r2.token))).status, 403);
    assert.equal((await http.get('/api/admin/resellers').set(auth(r1.token))).status, 403);
    assert.equal((await http.put('/api/admin/settings').set(auth(r1.token)).send({ brandName: 'x' })).status, 403);
    // customers cannot see settings of the platform
    assert.equal((await http.get('/api/admin/settings').set(auth(c1.token))).status, 403);
    // malformed ids never reach the database
    assert.equal((await http.get('/api/c/contacts/not-an-id').set(auth(c1.token))).status, 404);
    // ...but a reseller's own customer is reachable for the reseller
    assert.equal((await http.get(`/api/reseller/customers/${c1.id}`).set(auth(r1.token))).status, 200);
  });

  test('NoSQL operator injection in filters and bodies is neutralised', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const r = await http.get('/api/c/contacts').query('q[$ne]=zzz&group[$ne]=x&status[$ne]=a').set(auth(token));
    assert.ok([200, 400].includes(r.status), `unexpected status ${r.status}`);
    if (r.status === 200) assert.equal(r.body.total, 0, 'operators are treated as plain text, never as query operators');
    const all = await http.get('/api/c/contacts').set(auth(token));
    assert.equal(all.body.total, 3);
    const login = await http.post('/api/auth/login').send({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(login.status, 400);
  });
});

const uid = () => String(Math.floor(100000000000 + Math.random() * 899999999999));

describe('workflow 10: provider configuration errors are displayed correctly', () => {
  let realFetch;
  afterEach(() => {
    if (realFetch) global.fetch = realFetch;
  });

  test('meta needs phone number id, WABA id and token; the form returns field errors', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    let r = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'meta' });
    assert.equal(r.status, 400);
    const fields = r.body.details.map((d) => d.field).sort();
    assert.deepEqual(fields, ['accessToken', 'phoneNumberId', 'wabaId']);
    r = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'meta', phoneNumberId: 'abc', wabaId: '123456', accessToken: 'x'.repeat(30) });
    assert.equal(r.status, 400, 'non-numeric ids are rejected');
    // connecting with nothing configured is a displayable result, not a crash
    r = await http.post('/api/c/whatsapp/connect').set(auth(token));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true); // default provider is the mock
    assert.equal(r.body.account.status, 'connected');
  });

  test('secrets are never returned and a bad token produces a readable error status', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    realFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token.', code: 190 } }) });
    let r = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'meta', phoneNumberId: uid(), wabaId: '9876543210', accessToken: 'EAAB-secret-token-value', appSecret: 'supersecretapp' });
    assert.equal(r.status, 200);
    assert.equal(r.body.account.hasAccessToken, true);
    assert.equal(r.body.account.hasAppSecret, true);
    assert.ok(!JSON.stringify(r.body).includes('EAAB-secret-token-value'));
    assert.ok(!JSON.stringify(r.body).includes('supersecretapp'));
    r = await http.post('/api/c/whatsapp/connect').set(auth(token));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.account.status, 'error');
    assert.match(r.body.account.lastError, /Invalid OAuth access token/);
    // credentials are encrypted at rest
    const { WhatsAppAccount } = require('../src/models');
    const raw = await WhatsAppAccount.findOne({ provider: 'meta', accessTokenEnc: { $ne: '' } }).sort({ _id: -1 }).lean();
    assert.ok(raw.accessTokenEnc && !raw.accessTokenEnc.includes('EAAB'));
  });

  test('network failure while testing the connection is reported, not thrown', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    realFetch = global.fetch;
    global.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND graph.facebook.com');
    };
    await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'meta', phoneNumberId: uid(), wabaId: '9876543210', accessToken: 'EAAB-secret-token-value' });
    const r = await http.post('/api/c/whatsapp/connect').set(auth(token));
    assert.equal(r.status, 200);
    assert.equal(r.body.account.status, 'error');
    assert.match(r.body.account.lastError, /Could not reach the WhatsApp Cloud API/);
    // and template submission is blocked with a clear message while not connected
    const t = await http.post('/api/c/templates').set(auth(token)).send({ name: 'tpl_a', language: 'en', category: 'MARKETING', body: 'Hello there' });
    const sub = await http.post(`/api/c/templates/${t.body.template._id}/submit`).set(auth(token));
    assert.equal(sub.status, 422);
  });

  test('a connected real provider cannot send while ALLOW_REAL_SEND=false (explicit exclusion)', async (ctx) => {
    const { config } = require('../src/config');
    const prevAllow = config.ALLOW_REAL_SEND;
    config.ALLOW_REAL_SEND = false; // the kill switch under test
    ctx.after(() => { config.ALLOW_REAL_SEND = prevAllow; });
    const { token } = await h.newTenant(http, { connect: false, contacts: 2 });
    realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(`${opts && opts.method ? opts.method : 'GET'} ${url}`);
      return { ok: true, status: 200, json: async () => ({ display_phone_number: '+1 555 000 1111', verified_name: 'Acme', data: [] }) };
    };
    await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'meta', phoneNumberId: uid(), wabaId: '9876543210', accessToken: 'EAAB-secret-token-value' });
    const conn = await http.post('/api/c/whatsapp/connect').set(auth(token));
    assert.equal(conn.body.ok, true);
    assert.equal(conn.body.account.verifiedName, 'Acme');
    // sync reads from the (stubbed) Graph API; imports nothing
    const sync = await http.post('/api/c/templates/sync').set(auth(token));
    assert.equal(sync.status, 200);
    assert.equal(sync.body.provider, 'meta');
    // a template + campaign: validation refuses to start with a precise reason
    const t = await Template.create({ ownerId: (await http.get('/api/auth/me').set(auth(token))).body.user._id, name: 'meta_tpl', language: 'en', body: 'Hello there', status: 'approved' });
    const camp = await h.createCampaign(http, token, String(t._id), { variableMap: {} });
    const v = await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token));
    assert.equal(v.body.ok, false);
    assert.ok(v.body.issues.some((i) => i.code === 'real_sending_disabled'));
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 422);
    assert.ok(!calls.some((c) => /\/messages$/.test(c)), 'no message may ever be posted to the Graph API');
    // switching provider is blocked while campaigns are in flight, allowed otherwise
    const back = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'mock' });
    assert.equal(back.status, 200);
  });

  test('campaign validation reports every problem at once when nothing is set up', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    const t = await http.post('/api/c/templates').set(auth(token)).send({ name: 'raw_draft', language: 'en', category: 'MARKETING', body: 'Hi {{first_name}}' });
    const camp = await h.createCampaign(http, token, t.body.template._id, { variableMap: {} });
    const v = (await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token))).body;
    const codes = v.issues.map((i) => i.code);
    for (const c of ['template_not_approved', 'whatsapp_not_connected', 'unmapped_variable']) assert.ok(codes.includes(c), `expected ${c} in ${codes}`);
  });
});

describe('workflow 11: webhooks', () => {
  const APP_SECRET = 'webhook-app-secret-123';
  let PHONE_ID = '555000111222';
  const freshPhoneId = () => String(Math.floor(100000000000 + Math.random() * 899999999999));
  const sign = (raw) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
  const post = (payload, signature) => {
    const raw = JSON.stringify(payload);
    const req = http.post('/api/webhooks/whatsapp').set('Content-Type', 'application/json');
    if (signature !== null) req.set('X-Hub-Signature-256', signature === undefined ? sign(raw) : signature);
    return req.send(raw);
  };
  const statusPayload = (id, status, ts = 1760000000) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id, status, timestamp: String(ts), recipient_id: '919000000100' }] } }] }],
  });

  async function tenantWithSentCampaign() {
    const t = await h.newTenant(http, { contacts: 3 });
    PHONE_ID = freshPhoneId();
    const put = await http.put('/api/c/whatsapp').set(auth(t.token)).send({ provider: 'mock', phoneNumberId: PHONE_ID, appSecret: APP_SECRET });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    await http.post('/api/c/whatsapp/connect').set(auth(t.token));
    const tpl = await h.approvedTemplate(http, t.token);
    const camp = await h.createCampaign(http, t.token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(t.token));
    // stop the mock from advancing by itself so webhook transitions are observable
    await http.put('/api/admin/settings').set(auth(t.adminToken)).send({ mockDeliveryDelayMs: 600000, mockReadDelayMs: 600000 });
    await h.drain(camp._id);
    const msgs = await CampaignMessage.find({ campaignId: camp._id }).sort({ _id: 1 });
    assert.equal(msgs.length, 3);
    assert.ok(msgs.every((m) => m.status === 'simulated_sent'));
    return { ...t, camp, msgs };
  }

  test('GET handshake echoes the challenge only for a known verify token', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    const { verifyToken } = (await http.get('/api/c/whatsapp').set(auth(token))).body.account;
    let r = await http.get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': verifyToken, 'hub.challenge': 'abc123' });
    assert.equal(r.status, 200);
    assert.equal(r.text, 'abc123');
    r = await http.get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'abc123' });
    assert.equal(r.status, 403);
    r = await http.get('/api/webhooks/whatsapp').query({ 'hub.mode': 'subscribe' });
    assert.equal(r.status, 400);
  });

  test('signature is required and checked against the tenant\'s own app secret', async () => {
    const { msgs } = await tenantWithSentCampaign();
    const payload = statusPayload(msgs[0].providerMessageId, 'delivered');
    assert.equal((await post(payload, null)).status, 401, 'missing signature');
    assert.equal((await post(payload, 'sha256=' + '0'.repeat(64))).status, 401, 'wrong signature');
    const other = `sha256=${crypto.createHmac('sha256', 'some-other-secret').update(JSON.stringify(payload)).digest('hex')}`;
    assert.equal((await post(payload, other)).status, 401, 'signed with another tenant\'s secret');
    assert.equal((await CampaignMessage.findById(msgs[0]._id)).status, 'simulated_sent', 'nothing may change on rejected requests');
    assert.equal((await http.post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').send('{"object":"page"}')).status, 400);
    assert.equal((await http.post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').send('not json')).status, 400);
  });

  test('valid events update statuses once; duplicates and out-of-order events are ignored', async () => {
    const { msgs, token } = await tenantWithSentCampaign();
    const id = msgs[0].providerMessageId;

    let r = await post(statusPayload(id, 'delivered', 1760000100));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, 1);
    let m = await CampaignMessage.findById(msgs[0]._id);
    assert.equal(m.status, 'simulated_delivered', 'mock rows stay simulated even when a webhook says delivered');
    assert.equal(m.deliveredAt.getTime(), 1760000100 * 1000);

    // the exact same delivery again (Meta retries): detected, nothing changes
    r = await post(statusPayload(id, 'delivered', 1760000100));
    assert.equal(r.body.duplicates, 1);
    assert.equal(r.body.applied, 0);
    assert.equal(await WebhookEvent.countDocuments({ eventId: `status|${id}|delivered|1760000100` }), 1);

    // a late "sent" after "delivered" must not move the status backwards
    r = await post(statusPayload(id, 'sent', 1760000200));
    assert.equal(r.body.applied, 0);
    assert.equal((await CampaignMessage.findById(msgs[0]._id)).status, 'simulated_delivered');

    // read advances it
    r = await post(statusPayload(id, 'read', 1760000300));
    assert.equal(r.body.applied, 1);
    assert.equal((await CampaignMessage.findById(msgs[0]._id)).status, 'simulated_read');

    // failed after read is impossible; failed on another message is applied
    r = await post(statusPayload(id, 'failed', 1760000400));
    assert.equal(r.body.applied, 0);
    const failPayload = statusPayload(msgs[1].providerMessageId, 'failed');
    failPayload.entry[0].changes[0].value.statuses[0].errors = [{ code: 131026, title: 'Message undeliverable' }];
    r = await post(failPayload);
    assert.equal(r.body.applied, 1);
    m = await CampaignMessage.findById(msgs[1]._id);
    assert.equal(m.status, 'simulated_failed');
    assert.match(m.error, /undeliverable/i);

    // unknown message ids are recorded as ignored, not errors
    r = await post(statusPayload('wamid.unknown', 'delivered'));
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, 1);

    // the events are visible to the tenant in the UI feed
    const feed = (await http.get('/api/c/whatsapp/events').set(auth(token))).body;
    assert.ok(feed.total >= 5);
  });

  test('batched events in one request are all applied; replaying the batch changes nothing', async () => {
    const { msgs } = await tenantWithSentCampaign();
    const payload = statusPayload(msgs[0].providerMessageId, 'delivered', 1760000500);
    payload.entry[0].changes[0].value.statuses.push({ id: msgs[1].providerMessageId, status: 'delivered', timestamp: '1760000501' });
    payload.entry[0].changes[0].value.statuses.push({ id: msgs[2].providerMessageId, status: 'delivered', timestamp: '1760000502' });
    const first = await post(payload);
    assert.equal(first.body.applied, 3);
    const replay = await post(payload);
    assert.equal(replay.body.applied, 0);
    assert.equal(replay.body.duplicates, 3);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: msgs[0].campaignId, status: 'simulated_delivered' }), 3);
  });

  test('an inbound STOP opts the contact out and excludes them from the next campaign', async () => {
    const { token, camp } = await tenantWithSentCampaign();
    const contact = (await http.get('/api/c/contacts').query({ limit: 1 }).set(auth(token))).body.data[0];
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: PHONE_ID }, messages: [{ id: 'wamid.in1', from: contact.phone.replace('+', ''), type: 'text', text: { body: ' STOP ' } }] } }] }],
    };
    let r = await post(payload);
    assert.equal(r.body.applied, 1);
    const c = await Contact.findById(contact._id);
    assert.equal(c.optedOut, true);
    assert.equal(c.optOutSource, 'whatsapp_stop');
    assert.equal((await post(payload)).body.duplicates, 1);
    // ordinary chatter is ignored
    const chat = JSON.parse(JSON.stringify(payload));
    chat.entry[0].changes[0].value.messages[0] = { id: 'wamid.in2', from: contact.phone.replace('+', ''), type: 'text', text: { body: 'what is the price?' } };
    r = await post(chat);
    assert.equal(r.body.applied, 0);
    const tpl = camp.templateId;
    const next = await h.createCampaign(http, token, tpl);
    const v = (await http.post(`/api/c/campaigns/${next._id}/validate`).set(auth(token))).body;
    assert.equal(v.summary.excluded.opted_out, 1);
  });

  test('template status webhooks update the template', async () => {
    const t = await h.newTenant(http, { connect: false });
    await http.put('/api/c/whatsapp').set(auth(t.token)).send({ provider: 'mock', phoneNumberId: '777000111222', appSecret: APP_SECRET });
    const created = await http.post('/api/c/templates').set(auth(t.token)).send({ name: 'hooked_tpl', language: 'en', category: 'MARKETING', body: 'Hello folks' });
    await Template.updateOne({ _id: created.body.template._id }, { $set: { status: 'pending' } });
    const payload = { object: 'whatsapp_business_account', entry: [{ id: 'W2', time: 1760000000, changes: [{ field: 'message_template_status_update', value: { metadata: { phone_number_id: '777000111222' }, event: 'REJECTED', message_template_name: 'hooked_tpl', message_template_language: 'en', reason: 'INVALID_FORMAT' } }] }] };
    const r = await post(payload);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, 1);
    const tpl = await Template.findById(created.body.template._id);
    assert.equal(tpl.status, 'rejected');
    assert.equal(tpl.rejectionReason, 'INVALID_FORMAT');
  });
});

describe('phone number ids are unique per tenant', () => {
  test('a second tenant cannot claim an already used phone number id', async () => {
    const a = await h.newTenant(http, { connect: false });
    const b = await h.newTenant(http, { connect: false });
    const id = String(Math.floor(100000000000 + Math.random() * 899999999999));
    assert.equal((await http.put('/api/c/whatsapp').set(auth(a.token)).send({ provider: 'mock', phoneNumberId: id })).status, 200);
    const r = await http.put('/api/c/whatsapp').set(auth(b.token)).send({ provider: 'mock', phoneNumberId: id });
    assert.equal(r.status, 409);
    assert.equal(r.body.details[0].field, 'phoneNumberId');
    // re-saving your own is fine
    assert.equal((await http.put('/api/c/whatsapp').set(auth(a.token)).send({ provider: 'mock', phoneNumberId: id })).status, 200);
  });
});
