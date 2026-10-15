const { test, describe, before, after, afterEach } = require('node:test');
const crypto = require('node:crypto');
const h = require('./helpers');
const { CampaignMessage, Campaign, User, Template, WhatsAppAccount, WhatsappApiConfig } = require('../src/models');

const { assert, auth, rand } = h;
let http;
const realFetch = global.fetch;

before(async () => {
  ({ http } = await h.setup());
});
after(h.teardown);
afterEach(() => {
  global.fetch = realFetch;
});

const PNG = (extra = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 1)]);
const WAV = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32, 2)]);

const upload = (token, buf, name, kind) => {
  const req = http.post('/api/c/media').set(auth(token));
  if (kind) req.query({ kind });
  return req.attach('file', buf, name);
};

async function credit(adminToken, kindPath, id, amount, action = 'add') {
  return http.post(`/api/admin/${kindPath}/${id}/credits`).set(auth(adminToken)).send({ action, amount });
}

describe('who can create whom, and who gets the campaign workspace', () => {
  test('admin creates resellers, direct customers and customers under a reseller', async () => {
    const adminToken = await h.adminLogin(http);
    const reseller = await h.makeReseller(http, adminToken);
    const direct = await h.makeCustomer(http, adminToken);
    const under = await h.makeCustomer(http, adminToken, { resellerId: reseller.id });
    const list = await http.get('/api/admin/customers').set(auth(adminToken)).query({ resellerId: reseller.id });
    assert.deepEqual(list.body.data.map((c) => c._id), [under.id]);
    const d = await http.get(`/api/admin/customers/${direct.id}`).set(auth(adminToken));
    assert.equal(d.body.customer.resellerId, null);
  });

  test('reseller creates customers under themselves only, within their limit', async () => {
    const adminToken = await h.adminLogin(http);
    const other = await h.makeReseller(http, adminToken);
    const reseller = await h.makeReseller(http, adminToken, { maxCustomers: 1 });
    const c = await h.makeCustomer(http, reseller.token, { base: '/api/reseller/customers' });
    const got = await http.get(`/api/reseller/customers/${c.id}`).set(auth(reseller.token));
    assert.equal(got.body.customer.resellerId, reseller.id);

    let r = await http.post('/api/reseller/customers').set(auth(reseller.token)).send({ name: 'X', email: `x_${rand()}@t.local`, password: h.PASSWORD });
    assert.equal(r.status, 422, 'limit of 1 customer reached');
    r = await http.post('/api/reseller/customers').set(auth(other.token)).send({ name: 'Y', email: `y_${rand()}@t.local`, password: h.PASSWORD, resellerId: other.id });
    assert.equal(r.status, 403, 'a reseller cannot choose the owning reseller');
    r = await http.get(`/api/reseller/customers/${c.id}`).set(auth(other.token));
    assert.equal(r.status, 404, 'another reseller cannot see this customer');
  });

  test('admin has no campaign workspace; reseller has one (isolated); customer cannot manage anyone', async () => {
    const adminToken = await h.adminLogin(http);
    const reseller = await h.makeReseller(http, adminToken);
    const customer = await h.makeCustomer(http, reseller.token, { base: '/api/reseller/customers' });

    assert.equal((await http.get('/api/c/contacts').set(auth(adminToken))).status, 403);
    assert.equal((await http.get('/api/c/contacts').set(auth(reseller.token))).status, 200);
    assert.equal((await http.get('/api/reseller/customers').set(auth(customer.token))).status, 403);
    assert.equal((await http.get('/api/admin/resellers').set(auth(reseller.token))).status, 403);

    // reseller runs their own campaign end to end, separate from their customer's data
    await h.fastMock(http, adminToken);
    await h.connectMock(http, reseller.token);
    await h.addContacts(http, reseller.token, 4);
    const tpl = await h.approvedTemplate(http, reseller.token);
    const camp = await h.createCampaign(http, reseller.token, tpl);
    const started = await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(reseller.token));
    assert.equal(started.status, 200, JSON.stringify(started.body));
    await h.drain(camp._id);
    const stats = (await http.get(`/api/c/campaigns/${camp._id}`).set(auth(reseller.token))).body.report.stats;
    assert.equal(stats.sent, 4);
    assert.equal((await http.get('/api/c/contacts').set(auth(customer.token))).body.total, 0, 'the customer sees none of the reseller data');
    assert.equal((await http.get(`/api/c/campaigns/${camp._id}`).set(auth(customer.token))).status, 404);
  });
});

describe('credits', () => {
  test('admin top-up -> reseller transfer -> reclaim, with ledger and permissions', async () => {
    const adminToken = await h.adminLogin(http);
    const reseller = await h.makeReseller(http, adminToken);
    const other = await h.makeReseller(http, adminToken);
    const customer = await h.makeCustomer(http, reseller.token, { base: '/api/reseller/customers' });

    let r = await credit(adminToken, 'resellers', reseller.id, 100);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.balance, 100);

    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token)).send({ action: 'add', amount: 30, note: 'invoice 7' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.balance, 30);
    assert.equal(r.body.yourBalance, 70);

    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token)).send({ action: 'add', amount: 1000 });
    assert.equal(r.status, 422, 'cannot transfer more than the wallet holds');
    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(other.token)).send({ action: 'add', amount: 1 });
    assert.equal(r.status, 404, "another reseller cannot touch this customer's wallet");
    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(customer.token)).send({ action: 'add', amount: 1 });
    assert.equal(r.status, 403, 'a customer cannot add credits');

    for (const amount of [0, -5, 1.5, 'abc']) {
      r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token)).send({ action: 'add', amount });
      assert.equal(r.status, 400, `amount ${amount} is rejected`);
    }

    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token)).send({ action: 'deduct', amount: 10 });
    assert.equal(r.body.balance, 20);
    assert.equal(r.body.yourBalance, 80);
    r = await http.post(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token)).send({ action: 'deduct', amount: 21 });
    assert.equal(r.status, 422, 'cannot reclaim more than the customer has');

    const mine = await http.get('/api/c/credits').set(auth(customer.token));
    assert.equal(mine.body.balance, 20);
    assert.ok(mine.body.data.length >= 2);
    const ledger = await http.get(`/api/reseller/customers/${customer.id}/credits`).set(auth(reseller.token));
    assert.ok(ledger.body.data.some((t) => t.reason === 'transfer_in' && t.amount === 30));
    assert.equal((await User.findById(reseller.id)).credits + (await User.findById(customer.id)).credits, 100, 'credits are conserved');

    r = await credit(adminToken, 'customers', customer.id, 5);
    assert.equal(r.body.balance, 25, 'admin can top up a customer directly');
    r = await credit(adminToken, 'customers', customer.id, 999, 'deduct');
    assert.equal(r.status, 422);
  });

  test('simulated (mock) campaigns are free', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 200);
    await h.drain(camp._id);
    assert.equal((await http.get('/api/c/credits').set(auth(token))).body.balance, 0);
  });
});

describe('media (ad creatives) in templates and campaigns', () => {
  test('upload validation: type from file bytes, kind, size, public URL', async () => {
    const { token } = await h.newTenant(http);
    let r = await upload(token, PNG(), 'ad.png');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.media.kind, 'image');
    const url = new URL(r.body.media.url);
    const file = await http.get(url.pathname);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal((await http.get('/media/' + 'f'.repeat(48) + '/x.png')).status, 404);

    assert.equal((await upload(token, Buffer.from('MZ this is not an image at all'), 'evil.png')).status, 415, 'content is checked, not the file name');
    assert.equal((await upload(token, PNG(), 'ad.png', 'video')).status, 415, 'kind mismatch');
    assert.equal((await upload(token, PNG(5 * 1048576), 'big.png')).status, 413, 'images over 5 MB');
    assert.equal((await http.post('/api/c/media').set(auth(token))).status, 400, 'no file');
    assert.equal((await upload(token, WAV(), 'hello.wav', 'audio')).body.media.kind, 'audio');
  });

  test('image template -> approved -> mock campaign carries the media; isolation and delete protection', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const other = await h.newTenant(http);
    const m = (await upload(token, PNG(), 'sale.png')).body.media;

    let r = await http.post('/api/c/templates').set(auth(token)).send({ name: `ad_${rand()}`, body: 'Big sale {{first_name}}!', headerType: 'image' });
    assert.equal(r.status, 400, 'an image header needs a file');
    r = await http.post('/api/c/templates').set(auth(token)).send({ name: `ad_${rand()}`, body: 'Sale', headerType: 'video', mediaId: m.id });
    assert.equal(r.status, 400, 'wrong kind of file');
    r = await http.post('/api/c/templates').set(auth(other.token)).send({ name: `ad_${rand()}`, body: 'Sale', headerType: 'image', mediaId: m.id });
    assert.equal(r.status, 400, "another tenant's file cannot be used");

    const tpl = await h.approvedTemplate(http, token, { headerType: 'image', mediaId: m.id });
    const shown = await http.get(`/api/c/templates/${tpl}`).set(auth(token));
    assert.equal(shown.body.template.media.kind, 'image');

    const camp = await h.createCampaign(http, token, tpl);
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 200);
    await h.drain(camp._id);
    const msg = await CampaignMessage.findOne({ campaignId: camp._id, status: { $ne: 'excluded' } });
    assert.equal(msg.media.kind, 'image');
    assert.match(msg.media.url, /\/media\//);

    assert.equal((await http.delete(`/api/c/media/${m.id}`).set(auth(other.token))).status, 404, "cannot delete another tenant's file");
    assert.equal((await http.delete(`/api/c/media/${m.id}`).set(auth(token))).status, 409, 'file used by a template is protected');
    const free = (await upload(token, PNG(), 'free.png')).body.media;
    assert.equal((await http.delete(`/api/c/media/${free.id}`).set(auth(token))).status, 200);
  });

  test('media-only templates, personalized captions, and legacy media headers work without a migration', async () => {
    const { token } = await h.newTenant(http, { contacts: 2 });
    const m = (await upload(token, PNG(), 'caption.png')).body.media;

    let r = await http.post('/api/c/templates/validate').set(auth(token)).send({
      name: `media_only_${rand()}`, body: '', headerType: 'none', attachmentType: 'image', mediaId: m.id,
    });
    assert.equal(r.body.valid, true, JSON.stringify(r.body.errors));
    r = await http.post('/api/c/templates/validate').set(auth(token)).send({
      name: `empty_${rand()}`, body: '', headerType: 'none', attachmentType: 'none',
    });
    assert.equal(r.body.valid, false);
    assert.ok(r.body.errors.some((error) => error.field === 'body'));

    const mediaOnly = await http.post('/api/c/templates').set(auth(token)).send({
      name: `media_only_${rand()}`, body: '', headerType: 'none', attachmentType: 'image', mediaId: m.id,
    });
    assert.equal(mediaOnly.status, 201, JSON.stringify(mediaOnly.body));
    const mediaOnlyId = mediaOnly.body.template._id;
    await WhatsAppAccount.updateOne({ ownerId: mediaOnly.body.template.ownerId }, { $set: { provider: 'meta' } });
    r = await http.post(`/api/c/templates/${mediaOnlyId}/submit`).set(auth(token));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'Official WhatsApp API needs a body text. Add text or use the QR/mock provider.');
    await WhatsAppAccount.updateOne({ ownerId: mediaOnly.body.template.ownerId }, { $set: { provider: 'mock' } });
    assert.equal((await http.post(`/api/c/templates/${mediaOnlyId}/submit`).set(auth(token))).status, 200);
    assert.equal((await http.post('/api/c/templates/sync').set(auth(token))).status, 200);

    const mediaCampaign = await h.createCampaign(http, token, mediaOnlyId);
    assert.equal((await http.post(`/api/c/campaigns/${mediaCampaign._id}/start`).set(auth(token))).status, 200);
    await h.drain(mediaCampaign._id);
    const mediaMessage = await CampaignMessage.findOne({ campaignId: mediaCampaign._id });
    assert.equal(mediaMessage.text, '');
    assert.equal(mediaMessage.media.kind, 'image');
    assert.match(mediaMessage.status, /^simulated_/);

    const captionId = await h.approvedTemplate(http, token, {
      headerType: 'none', attachmentType: 'image', mediaId: m.id, body: 'Hi {{first_name}}',
    });
    const newCaptionCampaign = await h.createCampaign(http, token, captionId);
    assert.equal((await http.post(`/api/c/campaigns/${newCaptionCampaign._id}/start`).set(auth(token))).status, 200);
    await h.drain(newCaptionCampaign._id);
    const newCaptionMessage = await CampaignMessage.findOne({ campaignId: newCaptionCampaign._id });
    assert.match(newCaptionMessage.text, /^Hi Person \d+$/);
    assert.equal(newCaptionMessage.media.kind, 'image');

    const legacyId = await h.approvedTemplate(http, token, {
      headerType: 'image', mediaId: m.id, body: 'Hi {{first_name}}',
    });
    await Template.updateOne({ _id: legacyId }, { $unset: { attachmentType: 1 } });
    const loadedLegacy = await http.get(`/api/c/templates/${legacyId}`).set(auth(token));
    assert.equal(loadedLegacy.body.template.headerType, 'image');
    assert.equal(loadedLegacy.body.template.media.kind, 'image');
    assert.equal(loadedLegacy.body.template.attachmentType, undefined);
    r = await http.put(`/api/c/templates/${legacyId}`).set(auth(token)).send({
      ...loadedLegacy.body.template, headerType: 'none', attachmentType: 'image',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.resetToDraft, false, 'saving legacy media fields without changes preserves approval');

    const captionCampaign = await h.createCampaign(http, token, legacyId);
    assert.equal((await http.post(`/api/c/campaigns/${captionCampaign._id}/start`).set(auth(token))).status, 200);
    await h.drain(captionCampaign._id);
    const captionMessage = await CampaignMessage.findOne({ campaignId: captionCampaign._id });
    assert.match(captionMessage.text, /^Hi Person \d+$/);
    assert.equal(captionMessage.media.kind, 'image');
    assert.match(captionMessage.status, /^simulated_/);

    const combined = await http.post('/api/c/templates').set(auth(token)).send({
      name: `combined_${rand()}`, body: 'Sale {{first_name}}', header: 'Special offer',
      headerType: 'text', attachmentType: 'image', mediaId: m.id,
    });
    assert.equal(combined.status, 201, JSON.stringify(combined.body));
    assert.equal(combined.body.template.headerType, 'text');
    assert.equal(combined.body.template.attachmentType, 'image');
    await WhatsAppAccount.updateOne({ ownerId: combined.body.template.ownerId }, { $set: { provider: 'meta' } });
    r = await http.post(`/api/c/templates/${combined.body.template._id}/submit`).set(auth(token));
    assert.equal(r.status, 422);
    assert.match(r.body.error, /only one header/i);
    await WhatsAppAccount.updateOne({ ownerId: combined.body.template.ownerId }, { $set: { provider: 'mock' } });
  });
});

describe('linked phone (QR) provider', () => {
  test('can be selected; reports idle without starting a connection; campaigns refuse until a phone is linked', async () => {
    const { token } = await h.newTenant(http, { contacts: 2 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    let r = await http.get('/api/c/whatsapp/qr').set(auth(token));
    assert.equal(r.status, 409, 'QR endpoints need the QR provider selected');
    r = await http.put('/api/c/whatsapp').set(auth(token)).send({ provider: 'qr' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.account.provider, 'qr');
    r = await http.get('/api/c/whatsapp/qr').set(auth(token));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'idle');
    assert.equal(r.body.qrImage, null);
    const v = await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token));
    assert.ok(v.body.issues.some((i) => i.code === 'whatsapp_not_connected'), JSON.stringify(v.body.issues));
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 422);
  });
});

describe('voice calling + CLI', () => {
  async function adminCfg(adminToken) {
    const r = await http.get('/api/admin/voice').set(auth(adminToken));
    assert.equal(r.status, 200);
    return r.body.config;
  }
  const voiceBody = (over = {}) => ({ name: `Voice ${rand()}`, text: 'Hello {{first_name}}, this is a reminder.', audience: { mode: 'all' }, ...over });

  test('only admins configure voice; CLI numbers are validated, unique and assignable', async () => {
    const adminToken = await h.adminLogin(http);
    const customer = await h.makeCustomer(http, adminToken);
    assert.equal((await http.get('/api/admin/voice').set(auth(customer.token))).status, 403);
    const cfg = await adminCfg(adminToken);
    assert.equal(cfg.mode, 'mock');
    assert.equal(cfg.hasApiKey, false);

    let r = await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: 'abc' });
    assert.equal(r.status, 400);
    const num = `9199${Math.floor(10000000 + Math.random() * 89999999)}`;
    r = await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: `+${num}`, label: 'Main' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.cli.number, num);
    assert.equal((await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: num })).status, 409);
    assert.equal((await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: '919900000001', assignedToId: '64b000000000000000000001' })).status, 400);

    // assigned to one customer: only that customer can use it
    const mine = await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: `9188${Math.floor(10000000 + Math.random() * 89999999)}`, assignedToId: customer.id });
    const stranger = await h.makeCustomer(http, adminToken);
    const seen = (t) => http.get('/api/c/voice').set(auth(t)).then((x) => x.body.clis.map((c) => c.number));
    assert.ok((await seen(customer.token)).includes(mine.body.cli.number));
    assert.ok(!(await seen(stranger.token)).includes(mine.body.cli.number));
    r = await http.post('/api/c/voice/campaigns').set(auth(stranger.token)).send(voiceBody({ cliNumberId: mine.body.cli._id }));
    assert.equal(r.status, 400, "a CLI assigned to someone else cannot be used");
    assert.ok((await seen(stranger.token)).includes(num), 'unassigned CLI is available to everyone');
  });

  describe('Company WhatsApp API configuration', () => {
    test('configuration is admin-only, customer responses expose no API key, and preset keeps the saved key', async () => {
      const adminToken = await h.adminLogin(http);
      const reseller = await h.makeReseller(http, adminToken);
      const customer = await h.makeCustomer(http, adminToken);
      const generatedKey = crypto.randomBytes(32).toString('hex');

      assert.equal((await http.get('/api/admin/wa-api').set(auth(reseller.token))).status, 403);
      assert.equal((await http.get('/api/admin/wa-api').set(auth(customer.token))).status, 403);
      let response = await http.put('/api/admin/wa-api').set(auth(adminToken)).send({
        mode: 'http',
        providerName: 'Local test vendor',
        baseUrl: 'https://vendor.example/send',
        method: 'GET',
        contentType: 'query',
        apiKey: generatedKey,
        paramNames: { apikey: 'apikey', mobile: 'mobile', msg: 'msg' },
        country: 'IN',
        mobileFormat: 'national',
        successPath: '',
        successValue: '',
        messageIdPath: '',
        mediaMapping: { image: 'img1', document: 'pdf' },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.config.hasApiKey, true);
      assert.ok(!JSON.stringify(response.body).includes(generatedKey));
      assert.ok(!Object.hasOwn(response.body.config, 'apiKeyEnc'));

      response = await http.post('/api/admin/wa-api/preset/wtap').set(auth(adminToken));
      assert.equal(response.status, 200);
      assert.equal(response.body.config.providerName, 'sms4power (wtap)');
      assert.equal(response.body.config.hasApiKey, true, 'preset leaves the existing API key untouched');
      const stored = await WhatsappApiConfig.findOne({ key: 'default' });
      assert.ok(stored.apiKeyEnc);
      assert.notEqual(stored.apiKeyEnc, generatedKey);

      const workspace = await http.get('/api/c/whatsapp').set(auth(customer.token));
      assert.equal(workspace.status, 200);
      assert.equal(workspace.body.account.waHttpAvailable, true);
      assert.ok(!JSON.stringify(workspace.body).includes(generatedKey));
      assert.ok(!JSON.stringify(workspace.body).includes('apiKeyEnc'));
      response = await http.put('/api/c/whatsapp').set(auth(customer.token)).send({ provider: 'wa_http' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      response = await http.post('/api/c/whatsapp/connect').set(auth(customer.token));
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.ok(!JSON.stringify(response.body).includes(generatedKey));

      await http.put('/api/admin/wa-api').set(auth(adminToken)).send({ mode: 'off' });
    });
  });

  test('mock voice campaign: validation, run, simulated statuses, failing numbers, no duplicates, cancel', async () => {
    const adminToken = await h.adminLogin(http);
    await h.fastMock(http, adminToken);
    const cli = (await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: `9177${Math.floor(10000000 + Math.random() * 89999999)}` })).body.cli;
    const customer = await h.makeCustomer(http, adminToken);
    await h.addContacts(http, customer.token, 4);
    await http.post('/api/c/contacts').set(auth(customer.token)).send({ name: 'Unreachable', phone: '9000000000' }); // ends in 0000

    // incomplete campaign is refused with readable reasons
    let r = await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ text: '' }));
    assert.equal(r.status, 201);
    let v = await http.post(`/api/c/campaigns/${r.body.campaign._id}/validate`).set(auth(customer.token));
    const codes = v.body.issues.map((i) => i.code);
    assert.ok(codes.includes('cli_missing') && codes.includes('voice_content_missing'), codes.join(','));
    assert.equal((await http.post(`/api/c/campaigns/${r.body.campaign._id}/start`).set(auth(customer.token))).status, 422);

    // wrong kind of audio file
    const img = (await upload(customer.token, PNG(), 'x.png')).body.media;
    r = await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ cliNumberId: cli._id, audioMediaId: img.id }));
    assert.equal(r.status, 400);

    const audio = (await upload(customer.token, WAV(), 'msg.wav', 'audio')).body.media;
    const key = `key-${rand()}-${rand()}`;
    r = await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ cliNumberId: cli._id, audioMediaId: audio.id, submissionKey: key }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const again = await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ cliNumberId: cli._id, submissionKey: key }));
    assert.equal(again.body.duplicate, true, 'the same submission never creates a second campaign');
    const id = r.body.campaign._id;
    assert.equal(r.body.campaign.channel, 'voice');

    v = await http.post(`/api/c/campaigns/${id}/validate`).set(auth(customer.token));
    assert.equal(v.body.ok, true, JSON.stringify(v.body));
    assert.equal(v.body.summary.eligible, 5);
    assert.match(v.body.summary.samples[0].text, /^Hello Person/);

    const edit = await http.patch(`/api/c/voice/campaigns/${id}`).set(auth(customer.token)).send({ name: 'Renamed voice' });
    assert.equal(edit.body.campaign.name, 'Renamed voice');

    const start = await http.post(`/api/c/campaigns/${id}/start`).set(auth(customer.token));
    assert.equal(start.status, 200, JSON.stringify(start.body));
    assert.equal(start.body.campaign.provider, 'voice_mock');
    assert.equal((await http.post(`/api/c/campaigns/${id}/start`).set(auth(customer.token))).status, 409, 'cannot start twice');
    await h.drain(id);
    const report = (await http.get(`/api/c/campaigns/${id}`).set(auth(customer.token))).body;
    assert.equal(report.report.simulated, true);
    assert.equal(report.report.stats.failed, 1, 'the 0000 number fails in simulation');
    assert.equal(report.report.stats.sent, 4);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: id, simulated: false }), 0, 'nothing is marked as really delivered');
    assert.equal((await http.get('/api/c/credits').set(auth(customer.token))).body.balance, 0, 'mock calls are free');

    // clone keeps the voice settings
    const clone = await http.post(`/api/c/campaigns/${id}/clone`).set(auth(customer.token));
    assert.equal(clone.status, 201, JSON.stringify(clone.body));
    assert.equal(clone.body.campaign.channel, 'voice');
    assert.equal(String(clone.body.campaign.voice.cliNumberId), String(cli._id));

    // cancel stops pending calls
    const c2 = (await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ cliNumberId: cli._id }))).body.campaign;
    await http.post(`/api/c/campaigns/${c2._id}/start`).set(auth(customer.token));
    const cancel = await http.post(`/api/c/campaigns/${c2._id}/cancel`).set(auth(customer.token));
    assert.equal(cancel.status, 200);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: c2._id, status: 'queued' }), 0);

    // tenant isolation
    const other = await h.makeCustomer(http, adminToken);
    assert.equal((await http.get(`/api/c/campaigns/${id}`).set(auth(other.token))).status, 404);
    assert.equal((await http.patch(`/api/c/voice/campaigns/${id}`).set(auth(other.token)).send({ name: 'x' })).status, 404);
  });

  test('real API mode: request building, credits per call, refunds, pause when out of credits, vendor callbacks', async () => {
    const adminToken = await h.adminLogin(http);
    const cli = (await http.post('/api/admin/voice/cli').set(auth(adminToken)).send({ number: `9166${Math.floor(10000000 + Math.random() * 89999999)}` })).body.cli;

    // configure the vendor API (templates are validated; a broken one is refused)
    let r = await http.put('/api/admin/voice').set(auth(adminToken)).send({ mode: 'http', apiUrl: 'https://voice.test/call', bodyTemplate: 'not json' });
    assert.equal(r.status, 400);
    r = await http.put('/api/admin/voice').set(auth(adminToken)).send({ mode: 'http', apiUrl: 'ftp://nope' });
    assert.equal(r.status, 400);
    r = await http.put('/api/admin/voice').set(auth(adminToken)).send({ mode: 'http', apiUrl: 'https://voice.test/call', apiKey: 'sekret-key' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.config.hasApiKey, true);
    assert.ok(!JSON.stringify(r.body).includes('sekret-key'), 'the API key is never returned');
    const webhookToken = r.body.config.webhookUrl.split('/').pop();

    const calls = [];
    global.fetch = async (url, opts) => {
      if (!String(url).startsWith('https://voice.test/')) return realFetch(url, opts);
      const body = JSON.parse(opts.body);
      calls.push({ url: String(url), headers: opts.headers, body });
      const bad = body.to.endsWith('0100');
      return new Response(JSON.stringify(bad ? { message: 'number blocked' } : { call_id: `call-${body.to}` }), { status: bad ? 400 : 200, headers: { 'Content-Type': 'application/json' } });
    };

    const customer = await h.makeCustomer(http, adminToken);
    await h.addContacts(http, customer.token, 5);
    const all = (await http.get('/api/c/contacts').set(auth(customer.token)).query({ limit: 50 })).body.data;
    await Promise.all(all.map((c, i) => http.patch(`/api/c/contacts/${c._id}`).set(auth(customer.token)).send({ name: `Qu"ote${i}\\x` })));
    const camp = (await http.post('/api/c/voice/campaigns').set(auth(customer.token)).send(voiceBody({ cliNumberId: cli._id }))).body.campaign;

    let v = await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(customer.token));
    assert.ok(v.body.issues.some((i) => i.code === 'insufficient_credits'), 'real calls need credits');
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(customer.token))).status, 422);

    assert.equal((await credit(adminToken, 'customers', customer.id, 5)).body.balance, 5);
    v = await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(customer.token));
    assert.equal(v.body.ok, true, JSON.stringify(v.body));
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(customer.token))).status, 200);
    // credits run out before the campaign finishes (admin removes 3 right after start)
    assert.equal((await credit(adminToken, 'customers', customer.id, 3, 'deduct')).body.balance, 2);
    for (let i = 0; i < 10; i += 1) await h.drain(null, 3).catch(() => {});
    let c = await Campaign.findById(camp._id);
    assert.equal(c.status, 'paused');
    assert.match(c.lastError, /credits/i);
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/resume`).set(auth(customer.token))).status, 200, 'resume is allowed once credits exist');
    await credit(adminToken, 'customers', customer.id, 10);
    await h.drain(camp._id);
    c = await Campaign.findById(camp._id);
    assert.equal(c.status, 'completed');

    const msgs = await CampaignMessage.find({ campaignId: camp._id }).sort({ phone: 1 });
    assert.equal(msgs.filter((m) => m.status === 'sent').length, 4);
    assert.equal(msgs.filter((m) => m.status === 'failed').length, 1);
    assert.match(msgs.find((m) => m.status === 'failed').error, /number blocked/);
    assert.ok(msgs.every((m) => m.simulated === false));
    // the failed call was refunded: balance = 2 + 10 - 4 charged calls
    assert.equal((await User.findById(customer.id)).credits, 8);

    const first = calls.find((x) => x.body.to.endsWith('0101'));
    assert.equal(first.headers.Authorization, 'Bearer sekret-key');
    assert.equal(first.body.from, cli.number);
    assert.match(first.body.text, /^Hello Qu"ote/, 'quotes in names cannot break the request');

    // vendor callbacks: token protected, applied once, never regress
    const cb = (token, payload) => http.post(`/api/webhooks/voice/${token}`).send(payload);
    assert.equal((await cb('wrong-token', { call_id: 'x', status: 'answered' })).status, 403);
    let w = await cb(webhookToken, { call_id: 'call-919000000101', status: 'answered' });
    assert.equal(w.body.result, 'applied');
    w = await cb(webhookToken, { call_id: 'call-919000000101', status: 'answered' });
    assert.equal(w.body.result, 'ignored', 'duplicate callback');
    w = await cb(webhookToken, { call_id: 'call-919000000101', status: 'failed' });
    assert.equal(w.body.result, 'ignored', 'an answered call cannot turn into failed');
    w = await cb(webhookToken, { call_id: 'call-919000000102', status: 'busy' });
    assert.equal(w.body.result, 'applied');
    assert.equal((await CampaignMessage.findOne({ providerMessageId: 'call-919000000102' })).status, 'failed');
    assert.equal((await CampaignMessage.findOne({ providerMessageId: 'call-919000000101' })).status, 'delivered');
    assert.equal((await cb(webhookToken, { call_id: 'nope', status: 'answered' })).body.result, 'ignored');

    // admin test call goes through the same adapter
    const t = await http.post('/api/admin/voice/test').set(auth(adminToken)).send({ to: '919811112222', cliNumberId: cli._id });
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.body.providerMessageId, 'call-919811112222');

    // switching provider while a campaign is running is refused; back to mock otherwise works
    r = await http.put('/api/admin/voice').set(auth(adminToken)).send({ mode: 'mock' });
    assert.equal(r.status, 200);
  });
});
