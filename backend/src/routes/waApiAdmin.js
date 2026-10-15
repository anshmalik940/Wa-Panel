const express = require('express');
const { z } = require('zod');
const { Campaign } = require('../models');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah } = require('../utils/httpError');
const { audit } = require('../utils/audit');
const waApi = require('../services/waApiService');
const provider = require('../providers/wa_http');
const { config } = require('../config');
const wa = require('../services/waSession');
const QRCode = require('qrcode');

const router = express.Router();

const paramNames = z.object({
  apikey: z.string().trim().min(1).max(80),
  mobile: z.string().trim().min(1).max(80),
  msg: z.string().trim().min(1).max(80),
  pdf: z.string().trim().max(80),
  img1: z.string().trim().max(80),
  img2: z.string().trim().max(80),
  country: z.string().trim().max(80),
}).partial();

const mediaMapping = z.object({
  image: z.string().trim().min(1).max(80),
  document: z.string().trim().min(1).max(80),
}).partial();

const metaConfig = z.object({
  phoneNumberId: z.string().trim().max(80),
  wabaId: z.string().trim().max(80),
  appId: z.string().trim().max(80),
  accessToken: z.string().trim().max(2000),
  appSecret: z.string().trim().max(500),
  verifyToken: z.string().trim().max(500),
  graphVersion: z.string().trim().max(20),
}).partial().strict();

const putSchema = z.object({
  activeProvider: z.enum(['mock', 'wa_http', 'meta', 'qr']),
  mode: z.enum(['off', 'http']),
  providerName: z.string().trim().max(80),
  baseUrl: z.string().trim().max(1000)
    .refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'The vendor URL must start with http:// or https://')
    .refine((v) => {
      if (!v) return true;
      try {
        return ![...new URL(v).searchParams.keys()].some((name) => /^(?:api[_-]?key|apikey|access[_-]?token|token|secret|key)$/i.test(name));
      } catch {
        return true;
      }
    }, 'Do not place the API key in the URL. Use the encrypted API-key field.'),
  method: z.enum(['GET', 'POST']),
  contentType: z.enum(['query', 'json', 'form']),
  apiKey: z.string().trim().max(500),
  defaultCaption: z.string().trim().max(200),
  paramNames,
  country: z.string().trim().max(10),
  mobileFormat: z.enum(['national', 'international']),
  successPath: z.string().trim().max(100),
  successValue: z.string().trim().max(100),
  messageIdPath: z.string().trim().max(100),
  mediaMapping,
  meta: metaConfig,
}).partial().strict();

router.get(
  '/',
  ah(async (req, res) => res.json({
    config: waApi.serializeConfig(await waApi.getConfig()),
    webhookUrl: `${config.PUBLIC_API_URL.replace(/\/$/, '')}/api/webhooks/whatsapp`,
  })),
);

router.put(
  '/',
  validate(putSchema),
  ah(async (req, res) => {
    const record = await waApi.getConfig();
    const b = req.body;
    const nextMode = b.mode === undefined ? record.mode : b.mode;
    if (nextMode !== record.mode && await Campaign.exists({ provider: 'wa_http', status: { $in: ['queued', 'running', 'paused'] } })) {
      throw new HttpError(409, 'Finish or cancel running/paused Company WhatsApp API campaigns before changing its mode.');
    }
    if (b.successPath && !b.successValue) {
      throw new HttpError(400, 'Set the expected success value or leave both success fields empty.', [{ field: 'successValue', message: 'Required when a success path is set' }]);
    }

    const patch = {};
    for (const key of ['mode', 'providerName', 'baseUrl', 'method', 'contentType', 'country', 'mobileFormat', 'successPath', 'successValue', 'messageIdPath', 'defaultCaption']) {
      if (b[key] !== undefined) patch[key] = b[key];
    }
    if (b.paramNames) patch.paramNames = { ...record.paramNames, ...b.paramNames };
    if (b.mediaMapping) patch.mediaMapping = { ...record.mediaMapping, ...b.mediaMapping };
    if (b.apiKey) patch.apiKeyEnc = waApi.encrypt(b.apiKey);
    if (b.activeProvider !== undefined) patch.activeProvider = b.activeProvider;
    if (b.meta) {
      patch.meta = { ...(record.meta.toObject ? record.meta.toObject() : record.meta), ...b.meta };
      for (const [input, field] of [['accessToken', 'accessTokenEnc'], ['appSecret', 'appSecretEnc'], ['verifyToken', 'verifyTokenEnc']]) {
        if (b.meta[input]) patch.meta[field] = waApi.encrypt(b.meta[input]);
        delete patch.meta[input];
      }
      if (Object.keys(b.meta).some((field) => ['phoneNumberId', 'wabaId', 'appId', 'accessToken', 'appSecret', 'verifyToken', 'graphVersion'].includes(field))) {
        patch.meta.status = 'not_configured';
        patch.meta.lastError = '';
        patch.meta.lastCheckedAt = null;
      }
    }
    if (b.activeProvider === undefined && b.mode === 'http' && record.activeProvider === 'mock') patch.activeProvider = 'wa_http';
    Object.assign(record, patch);
    await record.save();
    await audit(req, 'wa_api.configure', { meta: { mode: record.mode, provider: record.providerName, keyChanged: Boolean(b.apiKey) } });
    res.json({ config: waApi.serializeConfig(record) });
  }),
);

router.post(
  '/test-connection',
  validate(z.object({ provider: z.enum(['mock', 'wa_http', 'meta', 'qr']) })),
  ah(async (req, res) => {
    const record = await waApi.getConfig();
    const { provider: name } = req.body;
    let status = 'connected';
    let message = 'Connection is ready.';
    let details = {};
    try {
      if (name === 'wa_http') {
        const checked = await provider.checkConnection();
        details = checked;
      } else if (name === 'meta') {
        const ready = waApi.metaReady(record);
        if (!ready.ok) throw new HttpError(422, ready.problem);
        const metaProvider = require('../providers/meta');
        const checked = await metaProvider.checkConnection(waApi.metaAccount(record));
        record.meta.status = 'connected';
        record.meta.lastCheckedAt = new Date();
        record.meta.lastError = '';
        record.meta.displayPhone = checked.displayPhone || '';
        record.meta.verifiedName = checked.verifiedName || '';
        await record.save();
        details = checked;
      } else if (name === 'qr') {
        await wa.start('platform');
        const checked = await require('../providers/qr').checkConnection({ ownerId: 'platform' });
        details = checked;
      }
      await audit(req, 'wa_api.connection_test', { meta: { provider: name, ok: true } });
    } catch (err) {
      status = 'error';
      message = name === 'meta'
        ? 'Meta connection test failed. Check the saved credentials and connection.'
        : err instanceof HttpError ? err.message : err.message || 'Connection test failed.';
      if (name === 'meta') {
        record.meta.status = 'error';
        record.meta.lastCheckedAt = new Date();
        record.meta.lastError = message;
        await record.save();
      }
      await audit(req, 'wa_api.connection_test', { meta: { provider: name, ok: false } });
    }
    res.json({ provider: name, status, message, details, qrStatus: name === 'qr' ? wa.getState('platform').status : undefined });
  }),
);

router.post(
  '/preset/wtap',
  ah(async (req, res) => {
    const record = await waApi.getConfig();
    if (record.mode !== waApi.PRESET.mode && await Campaign.exists({ provider: 'wa_http', status: { $in: ['queued', 'running', 'paused'] } })) {
      throw new HttpError(409, 'Finish or cancel running/paused Company WhatsApp API campaigns before changing its mode.');
    }
    Object.assign(record, waApi.PRESET);
    const ready = waApi.isReady(record);
    await record.save();
    await audit(req, 'wa_api.preset', { meta: { preset: 'sms4power_wtap' } });
    res.json({ config: { ...waApi.serializeConfig(record), ready: ready.ok, readyProblem: ready.problem || '' } });
  }),
);

const testSchema = z.object({
  provider: z.enum(['mock', 'wa_http', 'meta', 'qr']).optional(),
  number: z.string().trim().regex(/^\+?\d{8,15}$/, 'Enter 8-15 digits including the country code'),
  text: z.string().max(4096).default('WA HTTP test message'),
});

router.post(
  '/test',
  validate(testSchema),
  ah(async (req, res) => {
    const record = await waApi.getConfig();
    const name = req.body.provider || record.activeProvider;
    const b = req.body;
    const message = { phone: b.number, text: b.text, media: null };
    let result;
    try {
      if (name === 'mock') {
        return res.json({ ok: true, simulated: true, message: 'Test mode: messages are simulated.' });
      }
      if (!config.ALLOW_REAL_SEND) throw new HttpError(422, 'Real sending is disabled on this server (ALLOW_REAL_SEND=false).');
      if (name === 'wa_http') {
        result = await provider.testSend(record, message);
      } else if (name === 'meta') {
        const ready = waApi.metaReady(record);
        if (!ready.ok) throw new HttpError(422, ready.problem);
        result = await require('../providers/meta').testSend(waApi.metaAccount(record), message);
      } else {
        await wa.sendMessage('platform', message);
        result = { providerMessageId: '' };
      }
    } catch (err) {
      if (err.response) {
        await audit(req, 'wa_api.test', { meta: { provider: name, status: err.response.status, ok: false } });
        return res.json({ ok: false, status: err.response.status, body: err.response.body });
      }
      throw new HttpError(err.status || 502, err.message || 'The WhatsApp vendor API request failed.');
    }
    await audit(req, 'wa_api.test', { meta: { provider: name, status: result.status || 200, ok: true } });
    res.json({ ok: true, status: result.status || 200, body: result.body, providerMessageId: result.providerMessageId || '' });
  }),
);

router.get('/qr', ah(async (req, res) => {
  const st = wa.getState('platform');
  const { qr, ...state } = st;
  res.json({
    ...state,
    qrImage: qr ? await QRCode.toDataURL(qr, { margin: 1, width: 280 }) : null,
    hasSavedSession: wa.hasSavedSession('platform'),
    warning: 'All users send from this phone. WhatsApp can restrict numbers that send bulk messages.',
  });
}));

router.post('/qr/start', ah(async (req, res) => {
  const st = await wa.start('platform', { fresh: req.body && req.body.fresh === true });
  await audit(req, 'wa_api.qr_start', { meta: { status: st.status } });
  res.json({ status: st.status });
}));

router.post('/qr/logout', ah(async (req, res) => {
  await wa.logout('platform');
  await audit(req, 'wa_api.qr_logout');
  res.json({ ok: true });
}));

module.exports = router;
