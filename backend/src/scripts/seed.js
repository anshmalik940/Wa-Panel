/* Usage: npm run seed            -> make sure the admin account exists
 *        npm run seed:demo       -> also create demo reseller + customer with sample data (idempotent) */
const bcrypt = require('bcryptjs');
const { config } = require('../config');
const { connectDb, disconnectDb } = require('../db');
const { User, Contact, Template, WhatsAppAccount } = require('../models');
const { bootstrapAdmin } = require('../services/bootstrap');
const { extractVars } = require('../utils/template');
const { randomToken } = require('../utils/crypto');

const DEMO_PASSWORD = 'Demo@12345';

async function demo() {
  const hash = await bcrypt.hash(DEMO_PASSWORD, config.BCRYPT_ROUNDS);
  let reseller = await User.findOne({ email: 'reseller@demo.test' });
  if (!reseller) {
    reseller = await User.create({ role: 'reseller', name: 'Demo Reseller', email: 'reseller@demo.test', passwordHash: hash, companyName: 'Demo Resale Co', maxCustomers: 10 });
  }
  let customer = await User.findOne({ email: 'customer@demo.test' });
  if (!customer) {
    customer = await User.create({
      role: 'customer', name: 'Demo Customer', email: 'customer@demo.test', passwordHash: hash, companyName: 'Demo Traders',
      resellerId: reseller._id, monthlyMessageLimit: 500, contactLimit: 1000,
    });
  }
  if (!(await WhatsAppAccount.exists({ ownerId: customer._id }))) {
    await WhatsAppAccount.create({ ownerId: customer._id, provider: 'mock', status: 'connected', displayPhone: 'Mock sandbox', verifiedName: 'Simulator (no real messages)', lastCheckedAt: new Date(), verifyToken: randomToken(16) });
  }
  if (!(await Contact.exists({ ownerId: customer._id }))) {
    const names = ['Aarav', 'Vivaan', 'Aditya', 'Diya', 'Ananya', 'Ishaan', 'Kavya', 'Rohan', 'Saanvi', 'Arjun'];
    const docs = [];
    for (let i = 0; i < 30; i += 1) {
      docs.push({
        ownerId: customer._id,
        name: `${names[i % names.length]} ${String.fromCharCode(65 + (i % 26))}`,
        phone: `+9198765${String(10000 + i)}`,
        phoneValid: true,
        email: `contact${i}@example.com`,
        groups: i % 3 === 0 ? ['VIP'] : i % 3 === 1 ? ['Retail'] : ['Wholesale'],
        attributes: { city: ['Delhi', 'Mumbai', 'Jaipur'][i % 3] },
        optedOut: i === 4 || i === 9,
        optedOutAt: i === 4 || i === 9 ? new Date() : null,
        optOutSource: i === 4 || i === 9 ? 'manual' : '',
      });
    }
    docs.push({ ownerId: customer._id, name: 'Bad Number', phone: '12345', phoneValid: false, groups: ['Retail'] });
    docs.push({ ownerId: customer._id, name: 'Always Fails', phone: '+919876500000', phoneValid: true, groups: ['Retail'] }); // mock rule: ends in 0000 -> simulated failure
    await Contact.insertMany(docs);
  }
  const tpls = [
    { name: 'welcome_offer', category: 'MARKETING', header: 'Hello!', body: 'Hi {{first_name}}, welcome to Demo Traders! Enjoy {{discount}} off your next order.', footer: 'Reply STOP to opt out', status: 'approved' },
    { name: 'order_update', category: 'UTILITY', header: '', body: 'Hi {{first_name}}, your order from {{city}} has been shipped.', footer: '', status: 'approved' },
    { name: 'festival_greeting', category: 'MARKETING', header: '', body: 'Warm festival wishes from all of us at Demo Traders!', footer: '', status: 'draft' },
  ];
  for (const t of tpls) {
    if (!(await Template.exists({ ownerId: customer._id, name: t.name, language: 'en' }))) {
      await Template.create({ ownerId: customer._id, language: 'en', variables: extractVars(t.body), syncSource: t.status === 'approved' ? 'mock' : 'none', ...t });
    }
  }
  console.log(`Demo data ready.\n  reseller@demo.test / ${DEMO_PASSWORD}\n  customer@demo.test / ${DEMO_PASSWORD}`);
}

(async () => {
  await connectDb(config.MONGODB_URI);
  const r = await bootstrapAdmin();
  if (!r.created && !r.missingConfig) console.log('Admin account already exists.');
  if (process.argv.includes('--demo')) await demo();
  await disconnectDb();
})().catch((err) => {
  console.error(err.isConfigError ? err.message : err);
  process.exit(1);
});
