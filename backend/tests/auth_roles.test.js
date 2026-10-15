const { test, describe, before, after } = require('node:test');
const h = require('./helpers');

const { assert, auth } = h;
let http;
let adminToken;

before(async () => {
  ({ http } = await h.setup());
  adminToken = await h.adminLogin(http);
});
after(h.teardown);

describe('workflow 1: admin -> reseller -> login', () => {
  test('admin creates a reseller who can then sign in; wrong password is rejected', async () => {
    const reseller = await h.makeReseller(http, adminToken, { companyName: 'Acme Resale', maxCustomers: 3 });
    assert.ok(reseller.token);
    const me = await http.get('/api/auth/me').set(auth(reseller.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'reseller');
    assert.equal(me.body.user.passwordHash, undefined, 'password hash must never be returned');

    const bad = await http.post('/api/auth/login').send({ email: reseller.email, password: 'WrongPass1' });
    assert.equal(bad.status, 401);
    const unknown = await http.post('/api/auth/login').send({ email: 'nobody@t.local', password: 'WrongPass1' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error, bad.body.error, 'same message for unknown user and wrong password');
  });

  test('duplicate email and weak password are rejected with field errors', async () => {
    const email = `dup_${h.rand()}@t.local`;
    const ok = await http.post('/api/admin/resellers').set(auth(adminToken)).send({ name: 'A', email, password: h.PASSWORD });
    assert.equal(ok.status, 201);
    const dup = await http.post('/api/admin/resellers').set(auth(adminToken)).send({ name: 'A', email, password: h.PASSWORD });
    assert.equal(dup.status, 409);
    const weak = await http.post('/api/admin/resellers').set(auth(adminToken)).send({ name: 'A', email: `w_${h.rand()}@t.local`, password: 'short' });
    assert.equal(weak.status, 400);
    assert.ok(weak.body.details.some((d) => d.field === 'password'));
  });

  test('unauthenticated and wrong-role requests are refused', async () => {
    assert.equal((await http.get('/api/admin/stats')).status, 401);
    assert.equal((await http.get('/api/admin/stats').set(auth('garbage.token.value'))).status, 401);
    const reseller = await h.makeReseller(http, adminToken);
    assert.equal((await http.get('/api/admin/stats').set(auth(reseller.token))).status, 403);
    // resellers run their own campaigns, so the workspace API is open to them (scoped to their own data)
    assert.equal((await http.get('/api/c/contacts').set(auth(reseller.token))).status, 200);
    const customer = await h.makeCustomer(http, adminToken);
    assert.equal((await http.get('/api/admin/stats').set(auth(customer.token))).status, 403);
    assert.equal((await http.get('/api/reseller/stats').set(auth(customer.token))).status, 403);
    // the administrator manages the platform and has no campaign workspace
    assert.equal((await http.get('/api/c/contacts').set(auth(adminToken))).status, 403);
  });
});

describe('workflow 2: reseller -> customer -> login', () => {
  test('reseller creates a customer who can sign in; capacity and scope are enforced', async () => {
    const r1 = await h.makeReseller(http, adminToken, { maxCustomers: 2 });
    const r2 = await h.makeReseller(http, adminToken);
    const c1 = await h.makeCustomer(http, r1.token, { base: '/api/reseller/customers' });
    await h.makeCustomer(http, r1.token, { base: '/api/reseller/customers' });
    assert.ok(c1.token);

    const third = await http.post('/api/reseller/customers').set(auth(r1.token)).send({ name: 'X', email: `x_${h.rand()}@t.local`, password: h.PASSWORD });
    assert.equal(third.status, 422, 'reseller capacity must be enforced');

    const mine = await http.get('/api/reseller/customers').set(auth(r1.token));
    assert.equal(mine.body.total, 2);
    const theirs = await http.get('/api/reseller/customers').set(auth(r2.token));
    assert.equal(theirs.body.total, 0);
    // another reseller cannot read or change my customer
    assert.equal((await http.get(`/api/reseller/customers/${c1.id}`).set(auth(r2.token))).status, 404);
    assert.equal((await http.patch(`/api/reseller/customers/${c1.id}`).set(auth(r2.token)).send({ name: 'Hijack' })).status, 404);
    assert.equal((await http.post(`/api/reseller/customers/${c1.id}/suspend`).set(auth(r2.token))).status, 404);
    // a reseller cannot hand customers to someone else
    const hand = await http.post('/api/reseller/customers').set(auth(r2.token)).send({ name: 'X', email: `y_${h.rand()}@t.local`, password: h.PASSWORD, resellerId: r1.id });
    assert.equal(hand.status, 403);
  });

  test('admin edits, reassigns, suspends and re-activates a customer', async () => {
    const r1 = await h.makeReseller(http, adminToken);
    const r2 = await h.makeReseller(http, adminToken);
    const c = await h.makeCustomer(http, r1.token, { base: '/api/reseller/customers' });

    let r = await http.patch(`/api/admin/customers/${c.id}`).set(auth(adminToken)).send({ resellerId: r2.id, monthlyMessageLimit: 77, companyName: 'Moved Co' });
    assert.equal(r.status, 200);
    assert.equal(r.body.customer.monthlyMessageLimit, 77);
    assert.equal((await http.get('/api/reseller/customers').set(auth(r1.token))).body.total, 0);
    assert.equal((await http.get('/api/reseller/customers').set(auth(r2.token))).body.total, 1);

    r = await http.post(`/api/admin/customers/${c.id}/suspend`).set(auth(adminToken));
    assert.equal(r.status, 200);
    // the already-issued token stops working immediately
    assert.equal((await http.get('/api/c/dashboard').set(auth(c.token))).status, 401);
    const login = await http.post('/api/auth/login').send({ email: c.email, password: h.PASSWORD });
    assert.equal(login.status, 403);
    await http.post(`/api/admin/customers/${c.id}/activate`).set(auth(adminToken));
    assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: h.PASSWORD })).status, 200);
  });

  test('suspending a reseller blocks login and assignment to it', async () => {
    const r = await h.makeReseller(http, adminToken);
    await http.post(`/api/admin/resellers/${r.id}/suspend`).set(auth(adminToken));
    assert.equal((await http.get('/api/reseller/stats').set(auth(r.token))).status, 401);
    const assign = await http.post('/api/admin/customers').set(auth(adminToken)).send({ name: 'C', email: `c_${h.rand()}@t.local`, password: h.PASSWORD, resellerId: r.id });
    assert.equal(assign.status, 400);
  });
});

describe('sessions, password change and reset', () => {
  test('change-password invalidates old sessions and returns a fresh token', async () => {
    const c = await h.makeCustomer(http, adminToken);
    const r = await http.post('/api/auth/change-password').set(auth(c.token)).send({ currentPassword: h.PASSWORD, newPassword: 'NewPassw0rd!' });
    assert.equal(r.status, 200);
    assert.equal((await http.get('/api/auth/me').set(auth(c.token))).status, 401, 'old token must die');
    assert.equal((await http.get('/api/auth/me').set(auth(r.body.token))).status, 200);
    const wrong = await http.post('/api/auth/change-password').set(auth(r.body.token)).send({ currentPassword: 'nope', newPassword: 'Another1234' });
    assert.equal(wrong.status, 400);
  });

  test('logout invalidates the token', async () => {
    const c = await h.makeCustomer(http, adminToken);
    assert.equal((await http.post('/api/auth/logout').set(auth(c.token))).status, 200);
    assert.equal((await http.get('/api/auth/me').set(auth(c.token))).status, 401);
  });

  test('forgot-password -> reset-password works once, token is single use', async () => {
    const c = await h.makeCustomer(http, adminToken);
    const unknown = await http.post('/api/auth/forgot-password').send({ email: 'ghost@t.local' });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.devResetLink, undefined, 'no link for unknown accounts (no enumeration)');
    const f = await http.post('/api/auth/forgot-password').send({ email: c.email });
    assert.equal(f.status, 200);
    assert.ok(f.body.devResetLink, 'development mode returns the link');
    const token = new URL(f.body.devResetLink).searchParams.get('token');
    const bad = await http.post('/api/auth/reset-password').send({ token: 'x'.repeat(40), password: 'BrandNew123' });
    assert.equal(bad.status, 400);
    const ok = await http.post('/api/auth/reset-password').send({ token, password: 'BrandNew123' });
    assert.equal(ok.status, 200);
    assert.equal((await http.post('/api/auth/reset-password').send({ token, password: 'AnotherNew123' })).status, 400);
    assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: 'BrandNew123' })).status, 200);
    assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: h.PASSWORD })).status, 401);
  });

  test('5 wrong passwords lock the account; a reset clears the lock', async () => {
    const c = await h.makeCustomer(http, adminToken);
    for (let i = 0; i < 5; i += 1) assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: 'Wrong1234' })).status, 401);
    assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: h.PASSWORD })).status, 423);
    const r = await http.post(`/api/admin/customers/${c.id}/reset-password`).set(auth(adminToken)).send({ password: 'Fresh12345' });
    assert.equal(r.status, 200);
    assert.equal((await http.post('/api/auth/login').send({ email: c.email, password: 'Fresh12345' })).status, 200);
  });
});

describe('admin stats, settings and audit', () => {
  test('stats are computed from real records', async () => {
    const before = (await http.get('/api/admin/stats').set(auth(adminToken))).body;
    await h.makeReseller(http, adminToken);
    await h.makeCustomer(http, adminToken);
    const after = (await http.get('/api/admin/stats').set(auth(adminToken))).body;
    assert.equal(after.resellers.active, before.resellers.active + 1);
    assert.equal(after.customers.active, before.customers.active + 1);
  });

  test('settings validate input, persist, and are audited', async () => {
    let r = await http.put('/api/admin/settings').set(auth(adminToken)).send({ mockFailureRate: 150 });
    assert.equal(r.status, 400);
    r = await http.put('/api/admin/settings').set(auth(adminToken)).send({ brandName: 'Acme Panel', defaultMonthlyMessageLimit: 321 });
    assert.equal(r.status, 200);
    const g = await http.get('/api/admin/settings').set(auth(adminToken));
    assert.equal(g.body.settings.brandName, 'Acme Panel');
    // new customers pick up the default limit
    const c = await http.post('/api/admin/customers').set(auth(adminToken)).send({ name: 'D', email: `d_${h.rand()}@t.local`, password: h.PASSWORD });
    assert.equal(c.body.customer.monthlyMessageLimit, 321);
    const audit = await http.get('/api/admin/audit').query({ action: 'settings.' }).set(auth(adminToken));
    assert.ok(audit.body.data.length >= 1);
    await http.put('/api/admin/settings').set(auth(adminToken)).send({ brandName: 'WA Campaign Panel', defaultMonthlyMessageLimit: 1000 });
  });

  test('resellers see an audit trail limited to their own customers', async () => {
    const r1 = await h.makeReseller(http, adminToken);
    const r2 = await h.makeReseller(http, adminToken);
    const c1 = await h.makeCustomer(http, r1.token, { base: '/api/reseller/customers', name: 'Visible To R1' });
    const a1 = await http.get('/api/reseller/audit').set(auth(r1.token));
    assert.ok(a1.body.data.some((e) => e.targetId === c1.id));
    const a2 = await http.get('/api/reseller/audit').set(auth(r2.token));
    assert.ok(!a2.body.data.some((e) => e.targetId === c1.id));
  });
});
