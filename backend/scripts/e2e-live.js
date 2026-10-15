#!/usr/bin/env node
/**
 * Live end-to-end check against a RUNNING server (real HTTP, real database, real queue worker).
 *
 *   node scripts/e2e-live.js                 run all workflows
 *   node scripts/e2e-live.js --after-restart check that the data created by the previous run survived a restart
 *
 * Env: API_URL (default http://localhost:5000), E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD (default: the .env admin).
 * Every run creates its own uniquely named accounts, so it is safe to re-run.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const API = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin@12345';
const STATE_FILE = process.env.E2E_STATE || path.join(__dirname, '.e2e-state.json');
const PASSWORD = 'Passw0rd!x';
const run = crypto.randomBytes(3).toString('hex');

let passed = 0;
const failures = [];

async function call(method, url, { token, body, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = raw ? body : JSON.stringify(body);
    if (!raw) h['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${API}${url}`, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json (csv / text) */ }
  return { status: res.status, json, text, headers: res.headers };
}

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✘ ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const section = (t) => console.log(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 60000, every = 500 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) return null;
    await sleep(every);
  }
}

const login = async (email, password = PASSWORD) => {
  const r = await call('POST', '/api/auth/login', { body: { email, password } });
  return r.status === 200 ? r.json.token : null;
};

async function afterRestart() {
  if (!fs.existsSync(STATE_FILE)) throw new Error(`No state file at ${STATE_FILE}. Run the full e2e first.`);
  const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  section('Workflow 12 — data survives an application restart');
  const token = await login(s.customerEmail);
  check('customer can still sign in after the restart', Boolean(token));
  if (!token) return;
  const contacts = await call('GET', '/api/c/contacts?limit=1', { token });
  check(`contacts persisted (${s.contactTotal})`, contacts.json && contacts.json.total === s.contactTotal, `got ${contacts.json && contacts.json.total}`);
  const camp = await call('GET', `/api/c/campaigns/${s.campaignId}`, { token });
  check('campaign persisted', camp.status === 200 && camp.json.campaign.status === 'completed');
  check('campaign report counts unchanged', camp.json && camp.json.report.stats.sent === s.sent && camp.json.report.stats.excluded === s.excluded, JSON.stringify(camp.json && camp.json.report.stats));
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  check('admin can still sign in', Boolean(adminToken));
}

async function main() {
  const health = await call('GET', '/api/health');
  if (health.status !== 200) throw new Error(`API not healthy at ${API}: HTTP ${health.status}`);
  console.log(`Running against ${API} (run id ${run})`);

  /* ---- 1 ---- */
  section('Workflow 1 — admin login → create reseller → reseller login');
  const bad = await call('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'wrong-password-1' } });
  check('wrong password is rejected (401)', bad.status === 401, `HTTP ${bad.status}`);
  const adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  check('admin signs in', Boolean(adminToken));
  if (!adminToken) throw new Error('Cannot continue without admin access (check E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD)');
  const resellerEmail = `reseller_${run}@e2e.test`;
  const mkRes = await call('POST', '/api/admin/resellers', { token: adminToken, body: { name: 'E2E Reseller', email: resellerEmail, password: PASSWORD, maxCustomers: 5 } });
  check('admin creates reseller', mkRes.status === 201, JSON.stringify(mkRes.json));
  const resellerToken = await login(resellerEmail);
  check('reseller signs in', Boolean(resellerToken));
  const stats = await call('GET', '/api/admin/stats', { token: adminToken });
  check('admin dashboard stats come from the database', stats.status === 200 && stats.json.resellers.active >= 1);

  /* ---- 2 ---- */
  section('Workflow 2 — reseller creates customer → customer login');
  const customerEmail = `customer_${run}@e2e.test`;
  const mkCust = await call('POST', '/api/reseller/customers', { token: resellerToken, body: { name: 'E2E Customer', email: customerEmail, password: PASSWORD, monthlyMessageLimit: 500 } });
  check('reseller creates customer', mkCust.status === 201, JSON.stringify(mkCust.json));
  let token = await login(customerEmail);
  check('customer signs in', Boolean(token));
  const customerId = mkCust.json && mkCust.json.customer._id;
  const otherEmail = `customer2_${run}@e2e.test`;
  const mkOther = await call('POST', '/api/admin/customers', { token: adminToken, body: { name: 'Other Tenant', email: otherEmail, password: PASSWORD } });
  check('admin creates a second, unrelated customer', mkOther.status === 201);
  const otherToken = await login(otherEmail);
  const reseller2Email = `reseller2_${run}@e2e.test`;
  await call('POST', '/api/admin/resellers', { token: adminToken, body: { name: 'Reseller Two', email: reseller2Email, password: PASSWORD } });
  const reseller2Token = await login(reseller2Email);

  /* ---- 3 ---- */
  section('Workflow 3 — import contacts → edit a contact → export');
  // 60 sendable contacts. Last digit < 6 → the mock marks them "will read".
  let csv = 'Name,Mobile,Email,Group,City\n';
  for (let i = 1; i <= 60; i += 1) csv += `Person ${i},98${String(10000000 + i).slice(-8)},p${i}@e2e.test,vip,City${i % 3}\n`;
  csv += 'Bad Number,12345,,vip,Delhi\n'; // invalid → excluded later
  csv += 'Opted Out Olga,9877770001,,vip,Pune\n';
  csv += 'Will Fail,9876540000,,vip,Goa\n'; // mock rule: numbers ending 0000 fail
  csv += 'No City,9876543211,,vip,\n'; // missing {{city}} → excluded
  csv += 'Dupe In File,9810000001,,vip,X\n'; // same phone as Person 1
  const preview = await call('POST', '/api/c/contacts/import/preview', { token, body: { csv } });
  check('import preview detects the phone column', preview.status === 200 && preview.json.mapping.phone === 'Mobile', JSON.stringify(preview.json && preview.json.mapping));
  const imp = await call('POST', '/api/c/contacts/import', { token, body: { csv, duplicateMode: 'skip' } });
  check('import succeeds', imp.status === 200, JSON.stringify(imp.json));
  check('64 contacts created, duplicate row in file skipped, invalid number flagged', imp.json && imp.json.created === 64 && imp.json.skippedDuplicateInFile === 1 && imp.json.flaggedInvalidPhone === 1, JSON.stringify(imp.json));
  const imp2 = await call('POST', '/api/c/contacts/import', { token, body: { csv, duplicateMode: 'skip' } });
  check('re-importing the same file creates nothing (duplicate detection)', imp2.json && imp2.json.created === 0 && imp2.json.skippedExisting === 64, JSON.stringify(imp2.json));
  const search = await call('GET', '/api/c/contacts?q=Olga', { token });
  const olga = search.json.data[0];
  check('search finds a contact', Boolean(olga));
  const edit = await call('PATCH', `/api/c/contacts/${olga._id}`, { token, body: { name: 'Olga (edited)', optedOut: true, groups: ['vip', 'edited'] } });
  check('contact edit + opt-out saved', edit.status === 200 && edit.json.contact.optedOut && edit.json.contact.name === 'Olga (edited)');
  const grp = await call('GET', '/api/c/contacts?group=edited', { token });
  check('group filter works', grp.json.total === 1);
  const optFilter = await call('GET', '/api/c/contacts?status=optedout', { token });
  check('opted-out filter works', optFilter.json.total === 1);
  const exp = await call('GET', '/api/c/contacts/export', { token });
  check('export returns CSV with the edit', exp.status === 200 && /text\/csv/.test(exp.headers.get('content-type')) && exp.text.includes('Olga (edited)') && exp.text.includes('opted_out'));
  check('export has one row per contact', exp.text.trim().split('\n').length === 65, `${exp.text.trim().split('\n').length} lines`);
  const contactsNow = await call('GET', '/api/c/contacts?limit=1', { token });
  const contactTotal = contactsNow.json.total;

  /* ---- 10 (part) ---- */
  section('Workflow 10 — provider configuration errors are shown clearly');
  const blocked = await call('POST', '/api/c/templates', { token, body: { name: 'welcome_msg', language: 'en', category: 'MARKETING', body: 'Hi {{first_name}}, greetings from {{city}}!' } });
  check('template created as draft', blocked.status === 201 && blocked.json.template.status === 'draft' && blocked.json.template.variables.join() === 'first_name,city', JSON.stringify(blocked.json));
  const tplId = blocked.json.template._id;
  const badTpl = await call('POST', '/api/c/templates', { token, body: { name: 'Bad Name!', body: 'x' } });
  check('invalid template is rejected with field errors', badTpl.status === 400 && Array.isArray(badTpl.json.details) && badTpl.json.details.length > 0);
  const submitUnconnected = await call('POST', `/api/c/templates/${tplId}/submit`, { token });
  check('submitting before WhatsApp is connected explains why (422)', submitUnconnected.status === 422 && /not connected/i.test(submitUnconnected.json.error), submitUnconnected.text);
  const metaNoCreds = await call('PUT', '/api/c/whatsapp', { token, body: { provider: 'meta' } });
  check('Cloud API without credentials is rejected with field errors (400)', metaNoCreds.status === 400 && metaNoCreds.json.details.some((d) => d.field === 'accessToken'), metaNoCreds.text);
  const metaSave = await call('PUT', '/api/c/whatsapp', { token, body: { provider: 'meta', phoneNumberId: `${Date.now()}`.slice(0, 15), wabaId: `${Date.now() + 1}`.slice(0, 15), accessToken: 'EAAB-invalid-token-for-e2e-0000', appSecret: 'e2e-app-secret-1234' } });
  check('credentials are stored (never echoed back)', metaSave.status === 200 && metaSave.json.account.hasAccessToken && !JSON.stringify(metaSave.json).includes('EAAB-invalid'));
  const metaConnect = await call('POST', '/api/c/whatsapp/connect', { token });
  check('connection test with a bad token reports status "error" with a message', metaConnect.status === 200 && metaConnect.json.ok === false && metaConnect.json.account.status === 'error' && metaConnect.json.account.lastError.length > 5, metaConnect.text.slice(0, 200));
  console.log(`      message shown to the user: “${metaConnect.json && metaConnect.json.account.lastError}”`);

  /* ---- mock provider on ---- */
  const waPhoneId = `${Date.now() + 7}`.slice(0, 15);
  const mockSave = await call('PUT', '/api/c/whatsapp', { token, body: { provider: 'mock', phoneNumberId: waPhoneId, appSecret: 'e2e-app-secret-1234' } });
  check('switched to the Mock provider', mockSave.status === 200 && mockSave.json.account.provider === 'mock');
  const mockConnect = await call('POST', '/api/c/whatsapp/connect', { token });
  check('mock connection test succeeds', mockConnect.json.ok === true && mockConnect.json.account.status === 'connected');
  const submit = await call('POST', `/api/c/templates/${tplId}/submit`, { token });
  check('template submitted for review → pending', submit.status === 200 && submit.json.template.status === 'pending', submit.text);
  const sync = await call('POST', '/api/c/templates/sync', { token });
  check('template sync (simulated review) approves it', sync.status === 200 && sync.json.updated === 1, sync.text);
  const tplNow = await call('GET', `/api/c/templates/${tplId}`, { token });
  check('template is approved and labelled as a simulated review', tplNow.json.template.status === 'approved' && tplNow.json.template.syncSource === 'mock');

  /* ---- 4 ---- */
  section('Workflow 4 — create campaign → select recipients → validate → start (mock)');
  const submissionKey = `e2e-${run}-main-key`;
  const body = {
    name: `E2E campaign ${run}`,
    templateId: tplId,
    audience: { mode: 'groups', groups: ['vip'], contactIds: [] },
    variableMap: { first_name: { source: 'field', field: 'first_name', fallback: 'friend' }, city: { source: 'field', field: 'attr:city' } },
    submissionKey,
  };
  const c1 = await call('POST', '/api/c/campaigns', { token, body });
  check('campaign created as draft', c1.status === 201 && c1.json.campaign.status === 'draft', c1.text);
  const campaignId = c1.json.campaign._id;
  const c1b = await call('POST', '/api/c/campaigns', { token, body });
  check('Workflow 8: re-submitting the same form returns the SAME campaign (no duplicate)', c1b.status === 200 && c1b.json.duplicate === true && c1b.json.campaign._id === campaignId);
  const list = await call('GET', `/api/c/campaigns?q=${encodeURIComponent(`E2E campaign ${run}`)}`, { token });
  check('only one campaign exists for that submission', list.json.total === 1);
  const val = await call('POST', `/api/c/campaigns/${campaignId}/validate`, { token });
  check('validation passes', val.status === 200 && val.json.ok === true, JSON.stringify(val.json));
  // Eligible: 60 people + Will Fail (sendable but fails in mock) = 61.  Excluded: invalid number, opted-out Olga, "No City" (missing {{city}}) = 3. Audience = 64.
  check('validation preview: 64 in audience, 61 eligible, exclusions explained', val.json.summary.audienceSize === 64 && val.json.summary.eligible === 61 && val.json.summary.excluded.opted_out === 1 && val.json.summary.excluded.invalid_phone === 1 && val.json.summary.excluded.missing_variable === 1, JSON.stringify(val.json.summary));
  check('validation preview shows personalised sample text', /Hi Person, greetings from City\d/.test(val.json.summary.samples[0].text), val.json.summary.samples[0] && val.json.summary.samples[0].text);
  const [s1, s2] = await Promise.all([call('POST', `/api/c/campaigns/${campaignId}/start`, { token }), call('POST', `/api/c/campaigns/${campaignId}/start`, { token })]);
  const codes = [s1.status, s2.status].sort();
  check('Workflow 8: two simultaneous "Start" clicks → one succeeds, one is refused (409)', codes[0] === 200 && codes[1] === 409, `got ${codes}`);

  /* ---- 5 + 6 ---- */
  section('Workflow 5 & 6 — queue processes recipients; report shows simulated statuses; invalid / opted-out excluded');
  const done = await waitFor(async () => {
    const r = await call('GET', `/api/c/campaigns/${campaignId}`, { token });
    return r.json && r.json.campaign.status === 'completed' ? r.json : null;
  }, { timeout: 90000 });
  check('campaign reaches "completed"', Boolean(done));
  const rep = (done || (await call('GET', `/api/c/campaigns/${campaignId}`, { token })).json).report;
  check('61 recipients, 3 excluded', rep.stats.recipients === 61 && rep.stats.excluded === 3, JSON.stringify(rep.stats));
  check('60 sent (simulated) + 1 failed (number ending 0000)', rep.stats.sent === 60 && rep.stats.failed === 1, JSON.stringify(rep.stats));
  check('report is flagged as simulated', rep.simulated === true);
  const msgs = await call('GET', `/api/c/campaigns/${campaignId}/messages?limit=100`, { token });
  const statuses = new Set(msgs.json.data.map((m) => m.status));
  check('every status is a simulated_* status (never claimed as a real delivery)', [...statuses].every((s) => /^simulated_|^excluded$/.test(s)), [...statuses].join());
  check('no message is a plain real "delivered"/"read"/"sent"', !msgs.json.data.some((m) => ['sent', 'delivered', 'read'].includes(m.status)));
  const exclusions = msgs.json.data.filter((m) => m.status === 'excluded').map((m) => m.excludedReason).sort();
  check('exclusion reasons: invalid_phone, missing_variable:city, opted_out', exclusions.join() === 'invalid_phone,missing_variable:city,opted_out', exclusions.join());
  const sim = await waitFor(async () => {
    const r = await call('GET', `/api/c/campaigns/${campaignId}`, { token });
    return r.json.report.stats.delivered > 0 ? r.json.report.stats : null;
  }, { timeout: 30000 });
  check('simulated delivery progress is reported over time (delivered/read funnel)', Boolean(sim), JSON.stringify(sim));
  const final = (await call('GET', `/api/c/campaigns/${campaignId}`, { token })).json.report.stats;
  const repExp = await call('GET', `/api/c/campaigns/${campaignId}/export`, { token });
  check('campaign report exports as CSV', repExp.status === 200 && repExp.text.includes('simulated') && repExp.text.includes('opted_out'));
  const dash = await call('GET', '/api/c/dashboard', { token });
  check('dashboard numbers are computed from real records', dash.json.contacts.total === contactTotal && dash.json.messagesLast30Days.sent >= 60 && dash.json.usage.messages === 60, JSON.stringify({ c: dash.json.contacts, m: dash.json.messagesLast30Days, u: dash.json.usage }));
  const usage = await call('GET', '/api/c/usage', { token });
  check('usage counted exactly the 60 sent messages (and flagged them simulated)', usage.json.messages.used === 60 && usage.json.messages.simulated === 60, JSON.stringify(usage.json.messages));

  /* ---- 7 ---- */
  section('Workflow 7 — cancellation stops pending work');
  // Add enough contacts that the worker needs several passes, so the cancel lands mid-run.
  let csv2 = 'Name,Phone,City\n';
  for (let i = 1; i <= 150; i += 1) csv2 += `Bulk ${i},97${String(20000000 + i).slice(-8)},Town\n`;
  const imp3 = await call('POST', '/api/c/contacts/import', { token, body: { csv: csv2, defaultGroup: 'bulk' } });
  check('150 more contacts imported into group "bulk"', imp3.json.created === 150, JSON.stringify(imp3.json));
  const c2 = await call('POST', '/api/c/campaigns', { token, body: { name: `E2E cancel ${run}`, templateId: tplId, audience: { mode: 'groups', groups: ['bulk'] }, variableMap: { first_name: { source: 'field', field: 'first_name' }, city: { source: 'field', field: 'attr:city' } } } });
  const cancelId = c2.json.campaign._id;
  const st2 = await call('POST', `/api/c/campaigns/${cancelId}/start`, { token });
  check('second campaign starts', st2.status === 200, st2.text);
  await waitFor(async () => {
    const r = await call('GET', `/api/c/campaigns/${cancelId}`, { token });
    return r.json.report.stats.sent > 0 ? true : null;
  }, { timeout: 30000, every: 150 });
  const cancel = await call('POST', `/api/c/campaigns/${cancelId}/cancel`, { token });
  check('cancel accepted', cancel.status === 200 && cancel.json.campaign.status === 'cancelled', cancel.text);
  const atCancel = (await call('GET', `/api/c/campaigns/${cancelId}`, { token })).json.report.stats;
  await sleep(4000);
  const later = (await call('GET', `/api/c/campaigns/${cancelId}`, { token })).json.report.stats;
  check('all waiting messages were cancelled instead of sent', later.cancelled > 0 && later.queued === 0 && later.sending === 0 && later.cancelled + later.sent === 150, JSON.stringify(later));
  check('nothing further was sent after the cancel (at most the one message already in flight completes)', later.sent - atCancel.sent <= 1, `before ${atCancel.sent}, after ${later.sent}`);
  check('nothing more happened in the following seconds', (await call('GET', `/api/c/campaigns/${cancelId}`, { token })).json.report.stats.sent === later.sent);
  console.log(`      cancel response said ${cancel.json.cancelledMessages} cancelled; final: ${later.sent} sent, ${later.cancelled} cancelled`);
  const recancel = await call('POST', `/api/c/campaigns/${cancelId}/cancel`, { token });
  check('cancelling twice is refused (409)', recancel.status === 409);
  const restart = await call('POST', `/api/c/campaigns/${cancelId}/start`, { token });
  check('a cancelled campaign cannot be started again (409)', restart.status === 409);

  /* ---- 8 (cont.) ---- */
  section('Workflow 8 — duplicate sends are impossible');
  const again = await call('POST', `/api/c/campaigns/${campaignId}/start`, { token });
  check('starting a completed campaign again is refused (409)', again.status === 409);
  const msgsAfter = await call('GET', `/api/c/campaigns/${campaignId}/messages?limit=1`, { token });
  check('message rows unchanged after the repeated start (64 = 61 + 3 excluded)', msgsAfter.json.total === 64, `got ${msgsAfter.json.total}`);

  /* ---- 9 ---- */
  section('Workflow 9 — tenant isolation and role permissions');
  const cid = olga._id;
  check('customer 2 cannot read customer 1’s contact (404)', (await call('GET', `/api/c/contacts/${cid}`, { token: otherToken })).status === 404);
  check('customer 2 cannot edit it (404)', (await call('PATCH', `/api/c/contacts/${cid}`, { token: otherToken, body: { name: 'hacked' } })).status === 404);
  check('customer 2 cannot delete it (404)', (await call('DELETE', `/api/c/contacts/${cid}`, { token: otherToken })).status === 404);
  const otherList = await call('GET', '/api/c/contacts', { token: otherToken });
  check('customer 2’s contact list is empty', otherList.json.total === 0);
  check('customer 2 cannot read customer 1’s campaign (404)', (await call('GET', `/api/c/campaigns/${campaignId}`, { token: otherToken })).status === 404);
  check('…its recipient report (404)', (await call('GET', `/api/c/campaigns/${campaignId}/messages`, { token: otherToken })).status === 404);
  check('…or its CSV export (404)', (await call('GET', `/api/c/campaigns/${campaignId}/export`, { token: otherToken })).status === 404);
  check('customer 2 cannot cancel/start it (404)', (await call('POST', `/api/c/campaigns/${campaignId}/cancel`, { token: otherToken })).status === 404);
  check('customer 2 cannot read customer 1’s template (404)', (await call('GET', `/api/c/templates/${tplId}`, { token: otherToken })).status === 404);
  const hijack = await call('POST', '/api/c/campaigns', { token: otherToken, body: { name: 'steal', templateId: tplId, audience: { mode: 'all' } } });
  check('customer 2 cannot create a campaign with customer 1’s template (404)', hijack.status === 404);
  const otherWa = await call('GET', '/api/c/whatsapp', { token: otherToken });
  check('customer 2 sees their own (empty) WhatsApp settings, not customer 1’s', otherWa.json.account.status === 'not_configured' && otherWa.json.account.phoneNumberId === '');
  const dup = await call('PUT', '/api/c/whatsapp', { token: otherToken, body: { provider: 'mock', phoneNumberId: waPhoneId } });
  check('a WhatsApp number already used by another tenant is refused (409)', dup.status === 409, dup.text);
  check('customer 2 audit log shows none of customer 1’s activity', (await call('GET', '/api/c/audit', { token: otherToken })).json.data.every((e) => !/campaign\.start|contact\.import/.test(e.action)));
  check('customer cannot reach admin APIs (403)', (await call('GET', '/api/admin/stats', { token })).status === 403);
  check('customer cannot reach reseller APIs (403)', (await call('GET', '/api/reseller/stats', { token })).status === 403);
  check('reseller cannot reach admin APIs (403)', (await call('GET', '/api/admin/resellers', { token: resellerToken })).status === 403);
  const resellerOwn = await call('GET', '/api/c/contacts', { token: resellerToken });
  check('reseller has their own campaign workspace, which never shows a customer’s contacts', resellerOwn.status === 200 && resellerOwn.json.data.length === 0);
  check('admin has no campaign workspace (403)', (await call('GET', '/api/c/contacts', { token: adminToken })).status === 403);
  check('no token → 401', (await call('GET', '/api/c/contacts')).status === 401);
  check('garbage token → 401', (await call('GET', '/api/c/contacts', { token: 'abc.def.ghi' })).status === 401);
  check('reseller 2 cannot see reseller 1’s customer (404)', (await call('GET', `/api/reseller/customers/${customerId}`, { token: reseller2Token })).status === 404);
  check('reseller 2 cannot suspend it (404)', (await call('POST', `/api/reseller/customers/${customerId}/suspend`, { token: reseller2Token })).status === 404);
  check('reseller 2 list does not include it', (await call('GET', '/api/reseller/customers', { token: reseller2Token })).json.total === 0);
  check('reseller 1 sees exactly their customer', (await call('GET', '/api/reseller/customers', { token: resellerToken })).json.total === 1);
  const susp = await call('POST', `/api/admin/customers/${mkOther.json.customer._id}/suspend`, { token: adminToken });
  check('admin suspends a customer', susp.status === 200);
  check('suspended customer’s existing session stops working (401)', (await call('GET', '/api/c/contacts', { token: otherToken })).status === 401);
  check('suspended customer cannot sign in (403)', (await call('POST', '/api/auth/login', { body: { email: otherEmail, password: PASSWORD } })).status === 403);
  await call('POST', `/api/admin/customers/${mkOther.json.customer._id}/activate`, { token: adminToken });
  const otherToken2 = await login(otherEmail);
  check('reactivated customer signs in again (with a fresh session)', Boolean(otherToken2));
  const limited = await call('PATCH', `/api/admin/customers/${customerId}`, { token: adminToken, body: { monthlyMessageLimit: 60 } });
  check('admin lowers the monthly limit to the amount already used', limited.status === 200);
  const c3 = await call('POST', '/api/c/campaigns', { token, body: { name: `E2E limit ${run}`, templateId: tplId, audience: { mode: 'groups', groups: ['bulk'] }, variableMap: { first_name: { source: 'field', field: 'first_name' }, city: { source: 'field', field: 'attr:city' } } } });
  const startLimited = await call('POST', `/api/c/campaigns/${c3.json.campaign._id}/start`, { token });
  check('account limits are enforced: campaign over the monthly limit is refused (422) with a clear reason', startLimited.status === 422 && startLimited.json.details.issues.some((i) => i.code === 'monthly_limit_exceeded'), startLimited.text);
  await call('PATCH', `/api/admin/customers/${customerId}`, { token: adminToken, body: { monthlyMessageLimit: 500 } });
  await call('DELETE', `/api/c/campaigns/${c3.json.campaign._id}`, { token });

  /* ---- 10 (cont.) ---- */
  section('Workflow 10 — provider errors at campaign time');
  await call('PUT', '/api/c/whatsapp', { token: otherToken2, body: { provider: 'mock' } });
  const tplOther = await call('POST', '/api/c/templates', { token: otherToken2, body: { name: 'notconnected', body: 'Hello there' } });
  const cOther = await call('POST', '/api/c/campaigns', { token: otherToken2, body: { name: 'no wa', templateId: tplOther.json.template._id, audience: { mode: 'all' } } });
  const startOther = await call('POST', `/api/c/campaigns/${cOther.json.campaign._id}/start`, { token: otherToken2 });
  const codesOther = startOther.json && startOther.json.details && startOther.json.details.issues ? startOther.json.details.issues.map((i) => i.code) : [];
  check('starting with an unapproved template + unconnected WhatsApp lists every problem (422)', startOther.status === 422 && codesOther.includes('template_not_approved') && codesOther.includes('whatsapp_not_connected'), startOther.text);

  /* ---- 11 ---- */
  section('Workflow 11 — webhooks are verified and processed once');
  const wa = (await call('GET', '/api/c/whatsapp', { token })).json.account;
  const verifyOk = await call('GET', `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${wa.verifyToken}&hub.challenge=12345`);
  check('verification handshake echoes the challenge', verifyOk.status === 200 && verifyOk.text === '12345');
  const verifyBad = await call('GET', '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345');
  check('wrong verify token is refused (403)', verifyBad.status === 403);
  // pick a simulated message that is still only "sent"/"delivered" so a "read" event is a real change
  const target = (await call('GET', `/api/c/campaigns/${campaignId}/messages?status=delivered&limit=1`, { token })).json.data[0] || (await call('GET', `/api/c/campaigns/${campaignId}/messages?status=sent&limit=1`, { token })).json.data[0];
  const payload = (status, ts) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: waPhoneId }, statuses: [{ id: target.providerMessageId, status, timestamp: String(ts) }] } }] }] });
  const sign = (raw, secret = 'e2e-app-secret-1234') => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const post = (obj, secret, omit) => {
    const raw = JSON.stringify(obj);
    return call('POST', '/api/webhooks/whatsapp', { raw: true, body: raw, headers: { 'Content-Type': 'application/json', ...(omit ? {} : { 'X-Hub-Signature-256': sign(raw, secret) }) } });
  };
  const ts = Math.floor(Date.now() / 1000) + 5;
  check('unsigned webhook is refused (401)', (await post(payload('read', ts), undefined, true)).status === 401);
  check('webhook signed with the wrong secret is refused (401)', (await post(payload('read', ts), 'not-the-secret')).status === 401);
  const w1 = await post(payload('read', ts));
  check('valid signed status event is applied', w1.status === 200 && w1.json.applied === 1, w1.text);
  const w2 = await post(payload('read', ts));
  check('the identical event delivered again is detected as a duplicate and NOT applied twice', w2.status === 200 && w2.json.duplicates === 1 && w2.json.applied === 0, w2.text);
  const after = (await call('GET', `/api/c/campaigns/${campaignId}/messages?q=${encodeURIComponent(target.phone)}`, { token })).json.data[0];
  check('message moved to simulated_read — still labelled simulated, not a real "read"', after.status === 'simulated_read');
  const w3 = await post(payload('sent', ts + 10));
  check('an out-of-order older status ("sent" after "read") is ignored — no regression', w3.status === 200 && w3.json.applied === 0 && w3.json.ignored === 1, w3.text);
  const stop = await post({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: waPhoneId }, messages: [{ id: `wamid.${run}`, from: '919810000002', type: 'text', text: { body: 'STOP' } }] } }] }] });
  const p2 = (await call('GET', '/api/c/contacts?q=Person%202&limit=50', { token })).json.data.find((c) => c.phone.endsWith('9810000002') || c.phone.endsWith('98' + String(10000002).slice(-8)));
  check('an inbound "STOP" message opts the contact out automatically', stop.status === 200 && Boolean(p2) && p2.optedOut === true && p2.optOutSource === 'whatsapp_stop', stop.text);
  const ev = await call('GET', '/api/c/whatsapp/events?limit=20', { token });
  check('webhook events are listed for the tenant (one entry per unique event)', ev.json.total >= 2 && ev.json.data.some((e) => e.type === 'status.read'));
  check('events from other tenants are never shown', (await call('GET', '/api/c/whatsapp/events', { token: otherToken2 })).json.total === 0);

  /* ---- misc required features ---- */
  section('Other required features');
  const fgt = await call('POST', '/api/auth/forgot-password', { body: { email: customerEmail } });
  check('forgot-password gives the same answer for any address', fgt.status === 200);
  const fgt2 = await call('POST', '/api/auth/forgot-password', { body: { email: `nobody_${run}@e2e.test` } });
  check('…including unknown ones (no account enumeration)', fgt2.status === 200 && fgt2.json.message === fgt.json.message);
  const resetLink = fgt.json.resetLink || (fgt.json.devResetLink);
  if (resetLink) {
    const t = new URL(resetLink).searchParams.get('token');
    const rs = await call('POST', '/api/auth/reset-password', { body: { token: t, password: PASSWORD } });
    check('password reset with the emailed token works', rs.status === 200, rs.text);
    const reuse = await call('POST', '/api/auth/reset-password', { body: { token: t, password: PASSWORD } });
    check('a reset token cannot be used twice (400)', reuse.status === 400);
    check('the old session is invalidated by the reset (401)', (await call('GET', '/api/c/contacts', { token })).status === 401);
    token = await login(customerEmail);
    check('signing in with the new password works', Boolean(token));
  } else {
    console.log('  – reset link not returned by the API in this mode (production); covered by automated tests');
  }
  const settings = await call('GET', '/api/admin/settings', { token: adminToken });
  check('admin settings readable', settings.status === 200 && 'brandName' in settings.json.settings);
  const upd = await call('PUT', '/api/admin/settings', { token: adminToken, body: { mockFailureRate: 0, brandName: settings.json.settings.brandName } });
  check('admin settings writable', upd.status === 200);
  check('customer cannot change platform settings (403)', (await call('PUT', '/api/admin/settings', { token, body: { brandName: 'x' } })).status === 403);
  const audit = await call('GET', '/api/admin/audit?action=campaign.&limit=5', { token: adminToken });
  check('audit log records campaign actions', audit.status === 200 && audit.json.total >= 3);
  const bigCount = await call('GET', '/api/c/contacts?limit=1', { token });
  check('pagination metadata is returned', bigCount.json.pages >= 1 && bigCount.json.limit === 1);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ customerEmail, campaignId, contactTotal: bigCount.json.total, sent: final.sent, excluded: final.excluded, at: new Date().toISOString() }, null, 2));
  console.log(`\nState saved to ${STATE_FILE}. Restart the API, then run:  node scripts/e2e-live.js --after-restart   (workflow 12)`);
}

(async () => {
  try {
    if (process.argv.includes('--after-restart')) await afterRestart();
    else await main();
  } catch (err) {
    failures.push(`Script aborted: ${err.message}`);
    console.error(err);
  }
  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
})();
