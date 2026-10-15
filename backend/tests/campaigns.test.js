const { test, describe, before, after } = require('node:test');
const h = require('./helpers');
const { CampaignMessage, Campaign, Usage, Contact } = require('../src/models');

const { assert, auth } = h;
let http;

before(async () => {
  ({ http } = await h.setup());
});
after(h.teardown);

const statusOf = async (token, id, status) => (await http.get(`/api/c/campaigns/${id}/messages`).query({ status, limit: 100 }).set(auth(token))).body;

describe('workflow 3: contacts import -> edit -> export', () => {
  test('preview detects columns, import reports every outcome, duplicates are handled', async () => {
    const { token } = await h.newTenant(http);
    const csv = [
      'Full Name,Mobile,E-mail,Tags,City',
      'Asha Rao,98765 43210,asha@x.com,VIP;Retail,Delhi',
      'Bilal Khan,+91 98765 43211,bilal@x.com,Retail,Mumbai',
      'Asha Again,9876543210,asha2@x.com,,Delhi', // same phone as row 1 (in-file duplicate)
      'No Phone,,np@x.com,,',
      'Bad Email,9876543212,not-an-email,,',
      'Bad Number,12345,,,',
    ].join('\n');
    const prev = await http.post('/api/c/contacts/import/preview').set(auth(token)).send({ csv });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.mapping.phone, 'Mobile');
    assert.equal(prev.body.mapping.name, 'Full Name');
    assert.equal(prev.body.totalRows, 6);

    const r = await http.post('/api/c/contacts/import').set(auth(token)).send({ csv, defaultGroup: 'Imported' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.created, 3); // Asha, Bilal, Bad Number (flagged invalid)
    assert.equal(r.body.skippedDuplicateInFile, 1);
    assert.equal(r.body.flaggedInvalidPhone, 1);
    assert.equal(r.body.errorCount, 2); // empty phone, bad email
    assert.ok(r.body.errors.some((e) => /Phone number is empty/.test(e.message)));

    // re-import: existing contacts are detected as duplicates (skip), then updated
    const again = await http.post('/api/c/contacts/import').set(auth(token)).send({ csv });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.skippedExisting, 3);
    const upd = await http.post('/api/c/contacts/import').set(auth(token)).send({ csv, duplicateMode: 'update' });
    assert.equal(upd.body.updated, 3);

    const list = await http.get('/api/c/contacts').set(auth(token));
    assert.equal(list.body.total, 3);
    const asha = list.body.data.find((c) => c.name === 'Asha Rao');
    assert.equal(asha.phone, '+919876543210');
    assert.deepEqual(asha.groups.sort(), ['Imported', 'Retail', 'VIP']);
    assert.equal(asha.attributes.city, 'Delhi');
  });

  test('edit, search, filter, group, bulk actions and export', async () => {
    const { token } = await h.newTenant(http);
    await h.addContacts(http, token, 6, { group: 'Alpha', namePrefix: 'Zed' });
    let r = await http.get('/api/c/contacts').query({ q: 'Zed 3' }).set(auth(token));
    assert.equal(r.body.total, 1);
    const target = r.body.data[0];

    // edit
    r = await http.patch(`/api/c/contacts/${target._id}`).set(auth(token)).send({ name: 'Renamed Person', groups: ['Alpha', 'Beta'] });
    assert.equal(r.status, 200);
    assert.equal(r.body.contact.name, 'Renamed Person');
    // editing the phone to an invalid number saves with a warning and flags it
    r = await http.patch(`/api/c/contacts/${target._id}`).set(auth(token)).send({ phone: '123' });
    assert.ok(r.body.warning);
    assert.equal(r.body.contact.phoneValid, false);
    r = await http.patch(`/api/c/contacts/${target._id}`).set(auth(token)).send({ phone: '9811122233' });
    assert.equal(r.body.contact.phone, '+919811122233');
    assert.equal(r.body.contact.phoneValid, true);
    // duplicate phone is refused
    const other = (await http.get('/api/c/contacts').query({ q: 'Zed 1' }).set(auth(token))).body.data[0];
    r = await http.patch(`/api/c/contacts/${other._id}`).set(auth(token)).send({ phone: '9811122233' });
    assert.equal(r.status, 409);

    // filter by group and status
    r = await http.get('/api/c/contacts').query({ group: 'Beta' }).set(auth(token));
    assert.equal(r.body.total, 1);
    r = await http.get('/api/c/contacts/groups').set(auth(token));
    assert.deepEqual(r.body.groups.map((g) => [g.name, g.count]), [['Alpha', 6], ['Beta', 1]]);

    // bulk opt-out then filter
    const ids = (await http.get('/api/c/contacts').query({ limit: 2 }).set(auth(token))).body.data.map((c) => c._id);
    r = await http.post('/api/c/contacts/bulk').set(auth(token)).send({ action: 'optOut', ids });
    assert.equal(r.body.affected, 2);
    r = await http.get('/api/c/contacts').query({ status: 'optedout' }).set(auth(token));
    assert.equal(r.body.total, 2);

    // rename + delete group
    r = await http.patch('/api/c/contacts/groups/Beta').set(auth(token)).send({ name: 'Gamma' });
    assert.equal(r.body.renamed, 1);
    r = await http.delete('/api/c/contacts/groups/Gamma').set(auth(token));
    assert.equal(r.body.removedFrom, 1);

    // export: UTF-8 BOM, edited value present, honours filter
    r = await http.get('/api/c/contacts/export').set(auth(token));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/csv/);
    assert.match(r.headers['content-disposition'], /attachment/);
    assert.ok(r.text.startsWith('﻿name,phone,email,groups,status'));
    assert.match(r.text, /Renamed Person,\+919811122233/);
    assert.match(r.text, /opted_out/);
    r = await http.get('/api/c/contacts/export').query({ status: 'optedout' }).set(auth(token));
    assert.equal(r.text.trim().split('\n').length, 3); // header + 2 rows

    // delete
    r = await http.delete(`/api/c/contacts/${target._id}`).set(auth(token));
    assert.equal(r.status, 200);
    assert.equal((await http.get(`/api/c/contacts/${target._id}`).set(auth(token))).status, 404);
  });

  test('duplicate detection finds clusters and merge keeps one record (opt-out is sticky)', async () => {
    const { token } = await h.newTenant(http);
    const mk = (b) => http.post('/api/c/contacts').set(auth(token)).send(b);
    const a = (await mk({ name: 'Dup Person', phone: '9000011111', email: 'same@x.com', groups: ['G1'] })).body.contact;
    const b = (await mk({ name: 'Other Name', phone: '9000022222', email: 'same@x.com', groups: ['G2'] })).body.contact;
    await http.patch(`/api/c/contacts/${b._id}`).set(auth(token)).send({ optedOut: true });
    const d = await http.get('/api/c/contacts/duplicates').set(auth(token));
    assert.equal(d.body.total, 1);
    assert.equal(d.body.clusters[0].type, 'email');
    const m = await http.post('/api/c/contacts/merge').set(auth(token)).send({ keepId: a._id, mergeIds: [b._id] });
    assert.equal(m.status, 200);
    assert.deepEqual(m.body.contact.groups.sort(), ['G1', 'G2']);
    assert.equal(m.body.contact.optedOut, true);
    assert.equal((await http.get('/api/c/contacts').set(auth(token))).body.total, 1);
  });

  test('contact limit is enforced on create and import', async () => {
    const { token } = await h.newTenant(http, { limits: { contactLimit: 3 } });
    await h.addContacts(http, token, 3);
    const r = await http.post('/api/c/contacts').set(auth(token)).send({ phone: '9555500001' });
    assert.equal(r.status, 422);
    const imp = await http.post('/api/c/contacts/import').set(auth(token)).send({ csv: 'phone\n9555500002\n9555500003' });
    assert.equal(imp.body.created, 0);
    assert.equal(imp.body.notImportedLimit, 2);
  });
});

describe('templates', () => {
  test('validation, lifecycle (draft -> pending -> approved), edit resets approval, in-use protection', async () => {
    const { token } = await h.newTenant(http);
    let r = await http.post('/api/c/templates/validate').set(auth(token)).send({ name: 'Bad Name!', language: 'en', category: 'MARKETING', body: 'Hi {{ first name }}' });
    assert.equal(r.body.valid, false);
    assert.ok(r.body.errors.length >= 2);
    r = await http.post('/api/c/templates').set(auth(token)).send({ name: 'Bad Name!', body: 'x' });
    assert.equal(r.status, 400);
    r = await http.post('/api/c/templates/validate').set(auth(token)).send({ name: 'good_one', language: 'en', category: 'UTILITY', body: 'Hi {{first_name}} {{city}}' });
    assert.equal(r.body.valid, true);
    assert.deepEqual(r.body.variables, ['first_name', 'city']);

    const id = await h.approvedTemplate(http, token);
    r = await http.get(`/api/c/templates/${id}`).set(auth(token));
    assert.equal(r.body.template.status, 'approved');
    assert.equal(r.body.template.syncSource, 'mock');
    // editing approved content sends it back to draft
    r = await http.put(`/api/c/templates/${id}`).set(auth(token)).send({ ...r.body.template, body: 'Changed body {{first_name}}' });
    assert.equal(r.status, 200);
    assert.equal(r.body.resetToDraft, true);
    assert.equal(r.body.template.status, 'draft');
    // cannot submit twice
    assert.equal((await http.post(`/api/c/templates/${id}/submit`).set(auth(token))).status, 200);
    assert.equal((await http.post(`/api/c/templates/${id}/submit`).set(auth(token))).status, 409);
    await http.post('/api/c/templates/sync').set(auth(token));
    // a template used by a draft campaign cannot be deleted
    const camp = await h.createCampaign(http, token, id);
    r = await http.delete(`/api/c/templates/${id}`).set(auth(token));
    assert.equal(r.status, 409);
    await http.delete(`/api/c/campaigns/${camp._id}`).set(auth(token));
    assert.equal((await http.delete(`/api/c/templates/${id}`).set(auth(token))).status, 200);
  });

  test('template submit and sync need a connected WhatsApp account', async () => {
    const { token } = await h.newTenant(http, { connect: false });
    const created = await http.post('/api/c/templates').set(auth(token)).send({ name: 'needs_conn', language: 'en', category: 'MARKETING', body: 'Hello there' });
    const r = await http.post(`/api/c/templates/${created.body.template._id}/submit`).set(auth(token));
    assert.equal(r.status, 422);
    assert.match(r.body.error, /not connected/i);
    assert.equal((await http.post('/api/c/templates/sync').set(auth(token))).status, 422);
  });
});

describe('workflows 4-5: campaign validate -> start -> mock queue -> report', () => {
  test('full happy path with simulated statuses only', async () => {
    const { token } = await h.newTenant(http, { contacts: 10 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    assert.equal(camp.status, 'draft');

    const v = await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token));
    assert.equal(v.body.ok, true, JSON.stringify(v.body));
    assert.equal(v.body.summary.eligible, 10);
    assert.match(v.body.summary.samples[0].text, /^Hi Person, our sale is on!$/);

    const s = await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.campaign.status, 'running');
    assert.equal(s.body.campaign.provider, 'mock');

    await h.drain(camp._id);
    const { tick } = require('../src/services/queue');
    await tick();
    await tick();

    const detail = await http.get(`/api/c/campaigns/${camp._id}`).set(auth(token));
    assert.equal(detail.body.campaign.status, 'completed');
    const st = detail.body.report.stats;
    assert.equal(st.recipients, 10);
    assert.equal(st.sent, 10);
    assert.equal(st.delivered, 10);
    assert.ok(st.read > 0 && st.read < 10, `some but not all simulated reads, got ${st.read}`);
    assert.equal(detail.body.report.simulated, true);

    // honesty rule: nothing in mock mode is ever a real status
    const real = await CampaignMessage.countDocuments({ campaignId: camp._id, status: { $in: ['sent', 'delivered', 'read', 'failed'] } });
    assert.equal(real, 0, 'mock messages must only carry simulated_* statuses');
    const msgs = await statusOf(token, camp._id, 'delivered');
    assert.ok(msgs.data.every((m) => m.simulated === true));

    // usage tracked and shown
    const usage = (await http.get('/api/c/usage').set(auth(token))).body;
    assert.equal(usage.messages.used, 10);
    assert.equal(usage.messages.simulated, 10);
    const dash = (await http.get('/api/c/dashboard').set(auth(token))).body;
    assert.equal(dash.contacts.total, 10);
    assert.equal(dash.campaigns.completed, 1);
    assert.equal(dash.messagesLast30Days.sent, 10);
    assert.equal(dash.whatsapp.status, 'connected');
    assert.equal(dash.whatsapp.provider, 'mock');

    // csv report
    const exp = await http.get(`/api/c/campaigns/${camp._id}/export`).set(auth(token));
    assert.equal(exp.status, 200);
    assert.equal(exp.text.trim().split('\n').length, 11);
    assert.match(exp.text, /simulated_/);
  });

  test('numbers ending 0000 fail in the mock with a clear reason and are reported as failed', async () => {
    const { token } = await h.newTenant(http);
    await http.post('/api/c/contacts').set(auth(token)).send({ name: 'Fail Me', phone: '9812340000' });
    await http.post('/api/c/contacts').set(auth(token)).send({ name: 'Ok One', phone: '9812341111' });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 200);
    await h.drain(camp._id);
    const failed = await statusOf(token, camp._id, 'failed');
    assert.equal(failed.total, 1);
    assert.equal(failed.data[0].status, 'simulated_failed');
    assert.match(failed.data[0].error, /not registered/i);
    const detail = (await http.get(`/api/c/campaigns/${camp._id}`).set(auth(token))).body;
    assert.equal(detail.report.stats.failed, 1);
    assert.equal(detail.report.failureReasons[0].count, 1);
  });

  test('personalisation: fields, attributes, fixed values and fallbacks', async () => {
    const { token } = await h.newTenant(http);
    await http.post('/api/c/contacts').set(auth(token)).send({ name: 'Meera Nair', phone: '9700000011', attributes: { city: 'Pune' } });
    await http.post('/api/c/contacts').set(auth(token)).send({ name: '', phone: '9700000022' }); // no name, no city
    const tpl = await h.approvedTemplate(http, token, { body: 'Hi {{first_name}} from {{city}}! Code {{code}}.' });
    const camp = await h.createCampaign(http, token, tpl, {
      variableMap: {
        first_name: { source: 'field', field: 'first_name', fallback: 'friend' },
        city: { source: 'field', field: 'attr:city' }, // no fallback: contact without a city is excluded
        code: { source: 'fixed', value: 'SAVE10' },
      },
    });
    const v = (await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token))).body;
    assert.equal(v.summary.eligible, 1);
    assert.equal(v.summary.excluded.missing_variable, 1);
    assert.equal(v.summary.samples[0].text, 'Hi Meera from Pune! Code SAVE10.');
    // unmapped placeholder blocks the start
    const bad = await h.createCampaign(http, token, tpl, { variableMap: { first_name: { source: 'fixed', value: 'x' } } });
    const bv = (await http.post(`/api/c/campaigns/${bad._id}/validate`).set(auth(token))).body;
    assert.equal(bv.ok, false);
    assert.ok(bv.issues.some((i) => i.code === 'unmapped_variable'));
    assert.equal((await http.post(`/api/c/campaigns/${bad._id}/start`).set(auth(token))).status, 422);
  });

  test('audience selection by group and by explicit contacts', async () => {
    const { token } = await h.newTenant(http);
    const mk = (name, phone, groups) => http.post('/api/c/contacts').set(auth(token)).send({ name, phone, groups });
    await mk('North 1', '9400000001', ['North']);
    await mk('North 2', '9400000002', ['North']);
    const s1 = (await mk('South 1', '9400000003', ['South'])).body.contact;
    await mk('Both 1', '9400000004', ['North', 'South']);
    const tpl = await h.approvedTemplate(http, token);

    const north = await h.createCampaign(http, token, tpl, { audience: { mode: 'groups', groups: ['North'] } });
    assert.equal((await http.post(`/api/c/campaigns/${north._id}/validate`).set(auth(token))).body.summary.audienceSize, 3);
    const picked = await h.createCampaign(http, token, tpl, { audience: { mode: 'contacts', contactIds: [s1._id] } });
    assert.equal((await http.post(`/api/c/campaigns/${picked._id}/validate`).set(auth(token))).body.summary.audienceSize, 1);
    // an empty selection is rejected with a clear message
    const empty = await h.createCampaign(http, token, tpl, { audience: { mode: 'groups', groups: [] } });
    const v = (await http.post(`/api/c/campaigns/${empty._id}/validate`).set(auth(token))).body;
    assert.ok(v.issues.some((i) => i.code === 'no_audience_selected'));
    // unknown contact ids are refused at creation
    const bad = await http.post('/api/c/campaigns').set(auth(token)).send({ name: 'x', templateId: tpl, audience: { mode: 'contacts', contactIds: ['a'.repeat(24)] }, variableMap: {} });
    assert.equal(bad.status, 400);
  });
});

describe('workflow 6: invalid and opted-out recipients are excluded', () => {
  test('excluded contacts never receive messages and are reported with reasons', async () => {
    const { token } = await h.newTenant(http);
    const mk = (b) => http.post('/api/c/contacts').set(auth(token)).send(b);
    await mk({ name: 'Good A', phone: '9300000001' });
    await mk({ name: 'Good B', phone: '9300000002' });
    const optOut = (await mk({ name: 'Opted Out', phone: '9300000003' })).body.contact;
    await http.patch(`/api/c/contacts/${optOut._id}`).set(auth(token)).send({ optedOut: true });
    await mk({ name: 'Bad Number', phone: '12345' });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    const v = (await http.post(`/api/c/campaigns/${camp._id}/validate`).set(auth(token))).body;
    assert.equal(v.summary.audienceSize, 4);
    assert.equal(v.summary.eligible, 2);
    assert.equal(v.summary.excluded.opted_out, 1);
    assert.equal(v.summary.excluded.invalid_phone, 1);

    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    await h.drain(camp._id);
    const excluded = await statusOf(token, camp._id, 'excluded');
    assert.equal(excluded.total, 2);
    assert.deepEqual(excluded.data.map((m) => m.excludedReason).sort(), ['invalid_phone', 'opted_out']);
    const sent = await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ });
    assert.equal(sent, 2);
    // usage counts only real attempts
    assert.equal((await http.get('/api/c/usage').set(auth(token))).body.messages.used, 2);
  });

  test('a campaign where everyone is excluded cannot be started', async () => {
    const { token } = await h.newTenant(http);
    await http.post('/api/c/contacts').set(auth(token)).send({ name: 'Nope', phone: '12345' });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    const r = await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    assert.equal(r.status, 422);
    assert.ok(r.body.details.issues.some((i) => i.code === 'no_eligible_recipients'));
  });
});

describe('workflow 7: pause, resume, cancel', () => {
  test('cancel stops all pending work; sent messages stay', async () => {
    const { token } = await h.newTenant(http, { contacts: 12 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    const { tick } = require('../src/services/queue');
    await tick(); // batch size 4 in tests -> 4 sent
    const mid = await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ });
    assert.equal(mid, 4);

    const c = await http.post(`/api/c/campaigns/${camp._id}/cancel`).set(auth(token));
    assert.equal(c.status, 200);
    assert.equal(c.body.cancelledMessages, 8);
    await tick();
    await tick();
    const after = await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ });
    assert.equal(after, 4, 'nothing may be sent after cancel');
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: 'cancelled' }), 8);
    const detail = (await http.get(`/api/c/campaigns/${camp._id}`).set(auth(token))).body;
    assert.equal(detail.campaign.status, 'cancelled');
    // cancelling twice is refused, deleting a finished campaign is allowed
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/cancel`).set(auth(token))).status, 409);
    assert.equal((await http.delete(`/api/c/campaigns/${camp._id}`).set(auth(token))).status, 200);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id }), 0);
  });

  test('pause halts processing and resume continues exactly where it stopped', async () => {
    const { token } = await h.newTenant(http, { contacts: 10 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    const { tick } = require('../src/services/queue');
    await tick();
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/pause`).set(auth(token))).status, 200);
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/pause`).set(auth(token))).status, 409);
    await tick();
    await tick();
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 4, 'paused: no progress');
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/resume`).set(auth(token))).status, 200);
    await h.drain(camp._id);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 10);
    assert.equal((await http.get(`/api/c/campaigns/${camp._id}`).set(auth(token))).body.campaign.status, 'completed');
  });

  test('suspending the customer pauses their running campaigns', async () => {
    const { token, adminToken, customer } = await h.newTenant(http, { contacts: 8 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    const r = await http.post(`/api/admin/customers/${customer.id}/suspend`).set(auth(adminToken));
    assert.equal(r.body.pausedCampaigns, 1);
    const { tick } = require('../src/services/queue');
    await tick();
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 0);
    assert.equal((await Campaign.findById(camp._id)).status, 'paused');
  });
});

describe('scheduling', () => {
  test('schedule validates the time; due campaigns start automatically; unschedule returns to draft', async () => {
    const { token } = await h.newTenant(http, { contacts: 5 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    let r = await http.post(`/api/c/campaigns/${camp._id}/schedule`).set(auth(token)).send({ scheduledAt: new Date(Date.now() - 60000).toISOString() });
    assert.equal(r.status, 400);
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    r = await http.post(`/api/c/campaigns/${camp._id}/schedule`).set(auth(token)).send({ scheduledAt: future });
    assert.equal(r.status, 200);
    assert.equal(r.body.campaign.status, 'scheduled');
    r = await http.post(`/api/c/campaigns/${camp._id}/unschedule`).set(auth(token));
    assert.equal(r.body.campaign.status, 'draft');
    await http.post(`/api/c/campaigns/${camp._id}/schedule`).set(auth(token)).send({ scheduledAt: future });
    // not due yet: the scheduler must leave it alone
    const { tick } = require('../src/services/queue');
    await tick();
    assert.equal((await Campaign.findById(camp._id)).status, 'scheduled');
    // time passes
    await Campaign.updateOne({ _id: camp._id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    await h.drain(camp._id);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 5);
    assert.equal((await Campaign.findById(camp._id)).status, 'completed');
  });

  test('a scheduled campaign that became invalid fails with a readable reason instead of sending', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/schedule`).set(auth(token)).send({ scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString() });
    await http.post('/api/c/whatsapp/disconnect').set(auth(token));
    await Campaign.updateOne({ _id: camp._id }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
    const { tick } = require('../src/services/queue');
    await tick();
    const c = await Campaign.findById(camp._id);
    assert.equal(c.status, 'failed');
    assert.match(c.lastError, /not connected/i);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id }), 0);
  });
});

describe('workflow 8: duplicate submissions never create duplicate sends', () => {
  test('same submissionKey returns the same campaign (even when raced)', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const tpl = await h.approvedTemplate(http, token);
    const payload = {
      name: 'Once only',
      templateId: tpl,
      audience: { mode: 'all' },
      variableMap: { first_name: { source: 'field', field: 'first_name', fallback: 'there' } },
      submissionKey: `key-${h.rand()}-${h.rand()}`,
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => http.post('/api/c/campaigns').set(auth(token)).send(payload)));
    assert.ok(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.body)));
    const ids = new Set(results.map((r) => r.body.campaign._id));
    assert.equal(ids.size, 1);
    assert.equal(await Campaign.countDocuments({ ownerId: results[0].body.campaign.ownerId, submissionKey: payload.submissionKey }), 1);
  });

  test('double-clicking Start queues each recipient exactly once and charges usage once', async () => {
    const { token } = await h.newTenant(http, { contacts: 9 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    const starts = await Promise.all([1, 2, 3].map(() => http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))));
    const codes = starts.map((r) => r.status);
    assert.ok(codes.includes(200), `one start must succeed: ${JSON.stringify(starts.map((r) => r.body))}`);
    assert.ok(codes.every((c) => c === 200 || c === 409), `the others must be a clean 409, got ${codes}`);
    // The invariants that matter on any database: one message row per contact, one charge per message.
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id }), 9);
    await h.drain(camp._id);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 9);
    const usage = await Usage.findOne({ ownerId: camp.ownerId });
    assert.equal(usage.messages, 9, 'each recipient is charged exactly once');
    // starting again after completion is refused and changes nothing
    assert.equal((await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token))).status, 409);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id }), 9);
  });

  test('clone creates an independent draft', async () => {
    const { token } = await h.newTenant(http, { contacts: 2 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    const r = await http.post(`/api/c/campaigns/${camp._id}/clone`).set(auth(token));
    assert.equal(r.status, 201);
    assert.notEqual(r.body.campaign._id, camp._id);
    assert.equal(r.body.campaign.status, 'draft');
    assert.match(r.body.campaign.name, /^Copy of /);
  });
});

describe('account limits and campaign editing', () => {
  test('monthly limit blocks a campaign that would exceed it and pauses one that runs out', async () => {
    const { token } = await h.newTenant(http, { contacts: 10, limits: { monthlyMessageLimit: 6 } });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    const r = await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    assert.equal(r.status, 422);
    assert.ok(r.body.details.issues.some((i) => i.code === 'monthly_limit_exceeded'));
    // audience of 5 fits
    const some = (await http.get('/api/c/contacts').query({ limit: 5 }).set(auth(token))).body.data.map((c) => c._id);
    const camp2 = await h.createCampaign(http, token, tpl, { audience: { mode: 'contacts', contactIds: some } });
    assert.equal((await http.post(`/api/c/campaigns/${camp2._id}/start`).set(auth(token))).status, 200);
    await h.drain(camp2._id);
    assert.equal((await http.get('/api/c/usage').set(auth(token))).body.messages.remaining, 1);
    // a second 5-contact campaign no longer fits
    const camp3 = await h.createCampaign(http, token, tpl, { audience: { mode: 'contacts', contactIds: some } });
    assert.equal((await http.post(`/api/c/campaigns/${camp3._id}/start`).set(auth(token))).status, 422);
  });

  test('drafts can be edited; started campaigns cannot', async () => {
    const { token } = await h.newTenant(http, { contacts: 3 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    let r = await http.patch(`/api/c/campaigns/${camp._id}`).set(auth(token)).send({ name: 'Renamed campaign' });
    assert.equal(r.status, 200);
    assert.equal(r.body.campaign.name, 'Renamed campaign');
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    r = await http.patch(`/api/c/campaigns/${camp._id}`).set(auth(token)).send({ name: 'Too late' });
    assert.equal(r.status, 409);
    assert.equal((await http.delete(`/api/c/campaigns/${camp._id}`).set(auth(token))).status, 409, 'cannot delete a running campaign');
  });

  test('a draft template cannot be used in a campaign', async () => {
    const { token } = await h.newTenant(http, { contacts: 2 });
    const t = await http.post('/api/c/templates').set(auth(token)).send({ name: 'not_ready', language: 'en', category: 'MARKETING', body: 'Hello all' });
    const camp = await h.createCampaign(http, token, t.body.template._id, { variableMap: {} });
    const r = await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    assert.equal(r.status, 422);
    assert.ok(r.body.details.issues.some((i) => i.code === 'template_not_approved'));
  });

  test('list filters and pagination work', async () => {
    const { token } = await h.newTenant(http, { contacts: 2 });
    const tpl = await h.approvedTemplate(http, token);
    for (let i = 0; i < 3; i += 1) await h.createCampaign(http, token, tpl, { name: `Promo ${i}` });
    await h.createCampaign(http, token, tpl, { name: 'Other thing' });
    let r = await http.get('/api/c/campaigns').query({ q: 'promo' }).set(auth(token));
    assert.equal(r.body.total, 3);
    r = await http.get('/api/c/campaigns').query({ limit: 2, page: 2 }).set(auth(token));
    assert.equal(r.body.data.length, 2);
    assert.equal(r.body.pages, 2);
    r = await http.get('/api/c/campaigns').query({ status: 'completed' }).set(auth(token));
    assert.equal(r.body.total, 0);
  });
});

describe('workflow 12: restart safety', () => {
  test('records survive a reconnect and a half-processed campaign resumes without duplicates', async () => {
    const { token } = await h.newTenant(http, { contacts: 10 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    const { tick, recoverStale } = require('../src/services/queue');
    await tick(); // 4 processed

    // simulate a crash: one message stuck in "sending" with an old lock, then a process restart
    const stuck = await CampaignMessage.findOneAndUpdate({ campaignId: camp._id, status: 'queued' }, { $set: { status: 'sending', lockedAt: new Date(Date.now() - 10 * 60000) } }, { sort: { _id: 1 } });
    assert.ok(stuck);
    await h.mongoose.disconnect();
    await h.mongoose.connect(process.env.MONGODB_URI);

    assert.equal(await Contact.countDocuments({ ownerId: camp.ownerId }), 10, 'contacts persisted');
    const rec = await recoverStale();
    assert.equal(rec.requeued, 1);
    await h.drain(camp._id);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id }), 10);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 10, 'every contact sent exactly once');
    const usage = await Usage.findOne({ ownerId: camp.ownerId });
    assert.equal(usage.messages, 10);
    // login still works after the restart
    assert.equal((await http.get('/api/c/dashboard').set(auth(token))).status, 200);
  });

  test('a campaign interrupted between "queued" and "running" is materialised on recovery', async () => {
    const { token } = await h.newTenant(http, { contacts: 5 });
    const tpl = await h.approvedTemplate(http, token);
    const camp = await h.createCampaign(http, token, tpl);
    await http.post(`/api/c/campaigns/${camp._id}/start`).set(auth(token));
    // rewind: pretend the process died right after claiming the campaign
    await CampaignMessage.deleteMany({ campaignId: camp._id });
    await Campaign.updateOne({ _id: camp._id }, { $set: { status: 'queued', startedAt: new Date(Date.now() - 10 * 60000) } });
    const { recoverStale } = require('../src/services/queue');
    const rec = await recoverStale();
    assert.equal(rec.resumedCampaigns, 1);
    await h.drain(camp._id);
    assert.equal(await CampaignMessage.countDocuments({ campaignId: camp._id, status: /simulated_/ }), 5);
  });
});
