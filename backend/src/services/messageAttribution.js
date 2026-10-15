const { LastMessagedContact } = require('../models');

const phoneKey = (phone) => String(phone || '').replace(/\D/g, '');

async function rememberLastRecipient({ phone, ownerId, contactId, campaignId, sentAt = new Date() }) {
  const key = phoneKey(phone);
  if (!key) return;
  try {
    await LastMessagedContact.updateOne(
      { phone: key, $or: [{ sentAt: { $lte: sentAt } }, { sentAt: { $exists: false } }] },
      { $set: { ownerId, contactId, campaignId, sentAt } },
      { upsert: true },
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    await LastMessagedContact.updateOne(
      { phone: key, sentAt: { $lte: sentAt } },
      { $set: { ownerId, contactId, campaignId, sentAt } },
    );
  }
}

async function ownerForInbound(phone) {
  return LastMessagedContact.findOne({ phone: phoneKey(phone) }).select('ownerId contactId').lean();
}

module.exports = { rememberLastRecipient, ownerForInbound, phoneKey };
