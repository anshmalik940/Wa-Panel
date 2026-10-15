const crypto = require('crypto');
const { ProviderError } = require('./errors');

/**
 * Mock provider: exercises every campaign workflow without contacting WhatsApp.
 * Nothing it produces is a real delivery; messages are stored with simulated_* statuses.
 *
 * Deterministic rule for testing: numbers ending in 0000 always fail
 * ("not registered on WhatsApp"); all others succeed unless the admin-configured
 * random failure rate triggers.
 */
module.exports = {
  name: 'mock',
  simulated: true,

  async checkConnection() {
    return { displayPhone: 'Mock sandbox', verifiedName: 'Simulator (no real messages)' };
  },

  async send({ message, settings }) {
    if (/0000$/.test(message.phone)) {
      throw new ProviderError('Simulated failure: number is not registered on WhatsApp', { retryable: false, code: 'SIM_NOT_ON_WHATSAPP' });
    }
    if (Math.random() * 100 < (settings.mockFailureRate || 0)) {
      throw new ProviderError('Simulated random failure (admin mock failure rate)', { retryable: false, code: 'SIM_RANDOM' });
    }
    return { providerMessageId: `mock.${crypto.randomUUID()}` };
  },

  // mock "template review": handled in the templates route (pending -> approved on sync)
  async listTemplates() {
    return [];
  },

  async submitTemplate() {
    return { providerTemplateId: `mock-tpl.${crypto.randomUUID()}` };
  },
};
