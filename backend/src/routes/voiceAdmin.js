const express = require('express');
const { z } = require('zod');
const { CliNumber, Campaign, User } = require('../models');
const { validate } = require('../middleware/validate');
const { HttpError, asyncHandler: ah, idParam, OBJECT_ID_RE } = require('../utils/httpError');
const { encrypt, randomToken } = require('../utils/crypto');
const { audit } = require('../utils/audit');
const voice = require('../services/voiceService');
const { callVendor, requestValues, buildRequest } = require('../providers/voice');
const { config } = require('../config');

/** Admin: voice (calling) provider settings + CLI (caller-ID) numbers. Mounted at /api/admin/voice. */
const router = express.Router();
router.param('id', idParam);

const jsonObjectText = (label) =>
  z.string().max(4000).refine((v) => {
    try {
      const o = JSON.parse(String(v).replace(/\{\{\s*[a-zA-Z_]+\s*\}\}/g, 'x'));
      return o && typeof o === 'object' && !Array.isArray(o);
    } catch {
      return false;
    }
  }, `${label} must be a JSON object, e.g. {"to": "{{to}}"}`);

const putSchema = z
  .object({
    mode: z.enum(['mock', 'http']),
    providerName: z.string().trim().max(80),
    apiUrl: z.string().trim().max(500).refine((v) => !v || /^https?:\/\/[^\s]+$/i.test(v), 'The API URL must start with http:// or https://'),
    method: z.enum(['POST', 'GET']),
    contentType: z.enum(['json', 'form']),
    headersTemplate: jsonObjectText('Headers'),
    bodyTemplate: jsonObjectText('Request body'),
    apiKey: z.string().trim().min(1).max(500),
    clearApiKey: z.boolean(),
    callIdPath: z.string().trim().max(100),
    successPath: z.string().trim().max(100),
    successValue: z.string().trim().max(100),
    regenerateWebhookToken: z.boolean(),
  })
  .partial()
  .strict();

router.get(
  '/',
  ah(async (req, res) => res.json({ config: voice.serializeConfig(await voice.getConfig()) })),
);

router.put(
  '/',
  validate(putSchema),
  ah(async (req, res) => {
    const cfg = await voice.getConfig();
    const b = req.body;
    const set = {};
    for (const k of ['mode', 'providerName', 'apiUrl', 'method', 'contentType', 'headersTemplate', 'bodyTemplate', 'callIdPath', 'successPath', 'successValue']) if (b[k] !== undefined) set[k] = b[k];
    if (b.apiKey) set.apiKeyEnc = encrypt(b.apiKey);
    if (b.clearApiKey) set.apiKeyEnc = '';
    if (b.regenerateWebhookToken) set.webhookToken = randomToken(20);
    if (set.mode && set.mode !== cfg.mode && (await Campaign.exists({ channel: 'voice', status: { $in: ['queued', 'running', 'paused'] } }))) {
      throw new HttpError(409, 'Finish or cancel running/paused voice campaigns before switching between mock and real calling.');
    }
    const next = Object.assign(cfg, set);
    if (next.mode === 'http') {
      const ready = voice.isReady(next);
      if (!ready.ok) throw new HttpError(400, ready.problem, [{ field: 'apiUrl', message: ready.problem }]);
    }
    await cfg.save();
    await audit(req, 'voice.configure', { meta: { mode: cfg.mode, provider: cfg.providerName, keyChanged: Boolean(b.apiKey) } });
    res.json({ config: voice.serializeConfig(cfg) });
  }),
);

const testSchema = z.object({
  to: z.string().trim().regex(/^\+?\d{8,15}$/, 'Enter the number to call, with country code, e.g. 919876543210'),
  cliNumberId: z.string().regex(OBJECT_ID_RE).optional(),
  text: z.string().trim().max(300).default('This is a test call from the campaign panel.'),
  audioUrl: z.string().trim().max(500).default(''),
});

/** Places ONE test call (or simulates it in mock mode). Needs ALLOW_REAL_SEND=true for a real call. */
router.post(
  '/test',
  validate(testSchema),
  ah(async (req, res) => {
    const cfg = await voice.getConfig();
    const b = req.body;
    const cli = b.cliNumberId ? await CliNumber.findById(b.cliNumberId) : await CliNumber.findOne({ status: 'active' });
    if (!cli) throw new HttpError(400, 'Add an active CLI number first (or choose one).', [{ field: 'cliNumberId', message: 'No CLI number' }]);
    if (cfg.mode === 'mock') {
      await audit(req, 'voice.test_call', { meta: { mode: 'mock' } });
      return res.json({ ok: true, simulated: true, message: 'Mock mode: no real call was placed. Switch to "Real API" to test your vendor.' });
    }
    if (!config.ALLOW_REAL_SEND) throw new HttpError(422, 'Real calling is disabled on this server (ALLOW_REAL_SEND=false).');
    const values = requestValues({ message: { phone: `+${b.to.replace(/^\+/, '')}`, text: b.text, contactName: 'Test', media: b.audioUrl ? { url: b.audioUrl } : null, _id: 'test' }, campaign: { _id: 'test' }, cli: cli.number });
    let preview;
    try {
      preview = buildRequest(cfg, values);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    try {
      const r = await callVendor(cfg, values);
      await audit(req, 'voice.test_call', { meta: { mode: 'http', to: b.to.slice(-4).padStart(b.to.length, '*') } });
      return res.json({ ok: true, simulated: false, providerMessageId: r.providerMessageId, response: r.raw, requestPreview: { url: preview.url, method: preview.method } });
    } catch (err) {
      throw new HttpError(502, err.message || 'The voice API call failed');
    }
  }),
);

/* ---------- CLI numbers ---------- */
const cliBody = z.object({
  number: z.string().trim().transform((v) => v.replace(/[\s()+-]/g, '')).refine((v) => /^\d{5,15}$/.test(v), 'Enter 5-15 digits (the number the call will show), e.g. 919876543210'),
  label: z.string().trim().max(80).default(''),
  status: z.enum(['active', 'inactive']).default('active'),
  assignedToId: z.string().regex(OBJECT_ID_RE).nullable().optional(),
});

async function checkAssignee(id) {
  if (!id) return;
  const u = await User.findOne({ _id: id, role: { $in: ['reseller', 'customer'] } }).select('_id');
  if (!u) throw new HttpError(400, 'The selected user does not exist', [{ field: 'assignedToId', message: 'User not found' }]);
}

router.get(
  '/cli',
  ah(async (req, res) => {
    const rows = await CliNumber.find().sort({ number: 1 }).lean();
    const ids = [...new Set(rows.filter((r) => r.assignedToId).map((r) => String(r.assignedToId)))];
    const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name email role').lean() : [];
    const by = Object.fromEntries(users.map((u) => [String(u._id), u]));
    res.json({ data: rows.map((r) => ({ ...r, assignedTo: r.assignedToId ? by[String(r.assignedToId)] || null : null })) });
  }),
);

router.post(
  '/cli',
  validate(cliBody),
  ah(async (req, res) => {
    const b = req.body;
    await checkAssignee(b.assignedToId);
    try {
      const c = await CliNumber.create({ number: b.number, label: b.label, status: b.status, assignedToId: b.assignedToId || null, createdBy: req.user._id });
      await audit(req, 'cli.create', { targetType: 'cli', targetId: c._id, meta: { number: c.number } });
      res.status(201).json({ cli: c });
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'This CLI number already exists', [{ field: 'number', message: 'Already added' }]);
      throw err;
    }
  }),
);

router.patch(
  '/cli/:id',
  validate(cliBody.partial()),
  ah(async (req, res) => {
    const b = req.body;
    if (b.assignedToId !== undefined) await checkAssignee(b.assignedToId);
    const set = {};
    for (const k of ['number', 'label', 'status']) if (b[k] !== undefined) set[k] = b[k];
    if (b.assignedToId !== undefined) set.assignedToId = b.assignedToId || null;
    if (!Object.keys(set).length) throw new HttpError(400, 'Nothing to update');
    let c;
    try {
      c = await CliNumber.findOneAndUpdate({ _id: req.params.id }, { $set: set }, { new: true });
    } catch (err) {
      if (err.code === 11000) throw new HttpError(409, 'This CLI number already exists', [{ field: 'number', message: 'Already added' }]);
      throw err;
    }
    if (!c) throw new HttpError(404, 'CLI number not found');
    await audit(req, 'cli.update', { targetType: 'cli', targetId: c._id, meta: { fields: Object.keys(set) } });
    res.json({ cli: c });
  }),
);

router.delete(
  '/cli/:id',
  ah(async (req, res) => {
    const c = await CliNumber.findById(req.params.id);
    if (!c) throw new HttpError(404, 'CLI number not found');
    if (await Campaign.exists({ channel: 'voice', 'voice.cliNumberId': c._id, status: { $in: ['draft', 'scheduled', 'queued', 'running', 'paused'] } })) {
      throw new HttpError(409, 'This CLI number is used by an unfinished voice campaign. Deactivate it instead, or finish/cancel those campaigns.');
    }
    await CliNumber.deleteOne({ _id: c._id });
    await audit(req, 'cli.delete', { targetType: 'cli', targetId: c._id, meta: { number: c.number } });
    res.json({ ok: true });
  }),
);

module.exports = router;
