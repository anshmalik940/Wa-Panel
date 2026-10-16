const wa = require('../services/waSession');
const { ProviderError } = require('./errors');

/**
 * Linked-phone provider: messages leave from the customer's own WhatsApp number after they scan a QR code.
 * Unofficial (WhatsApp Web protocol). Templates need no Meta approval: they are simply approved when submitted.
 */
module.exports = {
  name: 'qr',
  simulated: false,
  paced: true,

  async checkConnection(account) {
    const st = wa.getState(account.ownerId);
    if (st.status !== 'connected') {
      throw new ProviderError(st.status === 'qr' ? 'Scan the QR code with WhatsApp on your phone (Linked devices) to connect.' : 'No phone is linked yet. Press "Generate QR code", then scan it.', { code: 'QR_NOT_LINKED' });
    }
    return { displayPhone: st.phone, verifiedName: st.name || 'Linked phone' };
  },

  async listTemplates() {
    return [];
  },

  async submitTemplate() {
    return { providerTemplateId: '', status: 'APPROVED' };
  },

  canSend(account) {
    return wa.canSend(account.ownerId);
  },

  getNextSendAt(account) {
    return wa.getNextSendAt(account.ownerId);
  },

  async send({ account, message, settings }) {
    try {
      return await wa.sendMessage(account.ownerId, { phone: message.phone, text: message.text, media: message.media });
    } finally {
      wa.scheduleNext(account.ownerId, settings.qrDelayMinMs, Math.max(settings.qrDelayMinMs, settings.qrDelayMaxMs));
    }
  },
};
