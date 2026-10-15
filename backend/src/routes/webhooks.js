const express = require('express');
const { asyncHandler: ah } = require('../utils/httpError');
const { verifyChallenge, handleWebhook } = require('../services/webhookService');

const router = express.Router();

// Meta verification handshake (configure this URL + your Verify Token in the Meta app dashboard)
router.get(
  '/whatsapp',
  ah(async (req, res) => {
    const challenge = await verifyChallenge(req.query);
    res.type('text/plain').send(challenge);
  }),
);

router.post(
  '/whatsapp',
  ah(async (req, res) => {
    const result = await handleWebhook({ body: req.body, rawBody: req.rawBody || Buffer.from(''), signature: req.get('x-hub-signature-256') });
    res.json({ ok: true, ...result });
  }),
);

// Voice vendor call-status callbacks. The secret token is part of the URL (shown on the admin Voice & CLI page).
// Accepts JSON or query-string params: { call_id | callId | id, status, reason? }.
router.all(
  '/voice/:token',
  ah(async (req, res) => {
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Use GET or POST' });
    const { applyCallback } = require('../services/voiceService');
    const out = await applyCallback(req.params.token, { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) });
    return res.json({ ok: true, ...out });
  }),
);

module.exports = router;
