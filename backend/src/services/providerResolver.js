const { WhatsAppAccount } = require('../models');
const { getProvider } = require('../providers');
const waApi = require('./waApiService');
const wa = require('./waSession');

const NOT_READY = 'Sending is not set up yet. Please contact your administrator.';

async function resolveWhatsApp(owner) {
  const ownerId = String(owner._id);
  const platform = await waApi.getConfig();

  if (owner.allowQr && owner.useOwnQr && wa.getState(ownerId).status === 'connected') {
    return {
      providerName: 'qr',
      source: 'own_qr',
      account: { ownerId, provider: 'qr', status: 'connected' },
      provider: getProvider('qr'),
      ready: true,
      problem: '',
      platform,
    };
  }

  const legacy = await WhatsAppAccount.findOne({ ownerId });
  if (legacy && legacy.provider === 'meta') {
    const ready = legacy.status === 'connected'
      && Boolean(legacy.phoneNumberId && legacy.wabaId && legacy.accessTokenEnc);
    if (ready) {
      return {
        providerName: 'meta',
        source: 'legacy_meta',
        account: legacy,
        provider: getProvider('meta'),
        ready: true,
        problem: '',
        platform,
      };
    }
  }

  const providerName = platform.activeProvider || 'mock';
  if (providerName === 'mock') {
    return { providerName, source: 'platform', account: { ownerId: 'platform', provider: providerName, status: 'connected' }, provider: getProvider(providerName), ready: true, problem: '', platform };
  }

  if (providerName === 'wa_http') {
    const state = waApi.isReady(platform);
    return {
      providerName,
      source: 'platform',
      account: { ownerId: 'platform', provider: providerName, status: state.ok ? 'connected' : 'not_configured' },
      provider: getProvider(providerName),
      ready: state.ok,
      problem: state.ok ? '' : NOT_READY,
      platform,
    };
  }

  if (providerName === 'meta') {
    const state = waApi.metaReady(platform);
    const connected = state.ok && platform.meta.status === 'connected';
    return {
      providerName,
      source: 'platform',
      account: waApi.metaAccount(platform),
      provider: getProvider(providerName),
      ready: connected,
      problem: connected ? '' : NOT_READY,
      platform,
    };
  }

  const connected = wa.getState('platform').status === 'connected';
  return {
    providerName: 'qr',
    source: 'platform',
    account: { ownerId: 'platform', provider: 'qr', status: connected ? 'connected' : 'not_configured' },
    provider: getProvider('qr'),
    ready: connected,
    problem: connected ? '' : NOT_READY,
    platform,
  };
}

module.exports = { resolveWhatsApp, NOT_READY };
