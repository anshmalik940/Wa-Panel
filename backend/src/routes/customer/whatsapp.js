const express = require('express');
const { z } = require('zod');
const { Campaign, WebhookEvent, User } = require('../../models');
const { validate } = require('../../middleware/validate');
const { HttpError, asyncHandler: ah } = require('../../utils/httpError');
const { pageParams, pageResult } = require('../../utils/pagination');
const { audit } = require('../../utils/audit');
const { resolveWhatsApp } = require('../../services/providerResolver');
const wa = require('../../services/waSession');
const QRCode = require('qrcode');

const router = express.Router();

function requireQrPermission(user) {
  if (!user.allowQr) throw new HttpError(403, 'Your administrator has not enabled own-phone QR access.');
}

router.get('/', ah(async (req, res) => {
  const resolved = await resolveWhatsApp(req.user);
  res.json({
    connection: {
      ready: resolved.ready,
      status: resolved.ready ? 'connected' : 'not_configured',
      source: resolved.source === 'own_qr' ? 'own_qr' : 'platform',
      provider: resolved.providerName,
      displayPhone: resolved.source === 'own_qr' ? wa.getState(req.user._id).phone : '',
    },
    allowQr: req.user.allowQr,
    useOwnQr: req.user.useOwnQr,
    simulated: resolved.providerName === 'mock',
  });
}));

router.put(
  '/',
  validate(z.object({ useOwnQr: z.boolean().optional(), allowQr: z.boolean().optional(), provider: z.literal('mock').optional() }).strict()),
  ah(async (req, res) => {
    if (req.body.allowQr !== undefined) throw new HttpError(403, 'Only an administrator can change QR access permission.');
    const nextUseOwnQr = req.body.useOwnQr;
    if (nextUseOwnQr === undefined) {
      const resolved = await resolveWhatsApp(req.user);
      return res.json({ ok: resolved.ready });
    }
    if (nextUseOwnQr && !req.user.allowQr) requireQrPermission(req.user);
    if (nextUseOwnQr !== req.user.useOwnQr && await Campaign.exists({
      ownerId: req.user._id,
      channel: 'whatsapp',
      status: { $in: ['queued', 'running', 'paused'] },
    })) {
      throw new HttpError(409, 'Finish or pause no WhatsApp campaigns before switching their sending phone.');
    }
    const updated = await User.findByIdAndUpdate(req.user._id, { $set: { useOwnQr: nextUseOwnQr } }, { new: true });
    await audit(req, 'whatsapp.source.update', { ownerId: req.user._id, meta: { useOwnQr: nextUseOwnQr } });
    const resolved = await resolveWhatsApp(updated);
    res.json({ connection: { ready: resolved.ready, source: resolved.source === 'own_qr' ? 'own_qr' : 'platform' }, useOwnQr: updated.useOwnQr });
  }),
);

router.post('/connect', ah(async (req, res) => {
  const resolved = await resolveWhatsApp(req.user);
  const status = resolved.ready ? 'connected' : 'not_configured';
  res.json({
    ok: resolved.ready,
    connection: { ready: resolved.ready, source: resolved.source === 'own_qr' ? 'own_qr' : 'platform' },
    account: { status, displayPhone: resolved.source === 'own_qr' ? wa.getState(req.user._id).phone : '' },
  });
}));

router.get(
  '/qr',
  ah(async (req, res) => {
    requireQrPermission(req.user);
    const st = wa.getState(req.user._id);
    res.json({
      status: st.status,
      phone: st.phone,
      name: st.name,
      lastError: st.lastError,
      qrImage: st.qr ? await QRCode.toDataURL(st.qr, { margin: 1, width: 280 }) : null,
      hasSavedSession: wa.hasSavedSession(req.user._id),
    });
  }),
);

router.post(
  '/qr/start',
  ah(async (req, res) => {
    requireQrPermission(req.user);
    try {
      const st = await wa.start(req.user._id, { fresh: req.body && req.body.fresh === true });
      await audit(req, 'whatsapp.qr_start', { ownerId: req.user._id });
      res.json({ status: st.status });
    } catch (err) {
      if (err.code === 'QR_NOT_INSTALLED') throw new HttpError(503, err.message);
      throw err;
    }
  }),
);

router.post(
  '/qr/logout',
  ah(async (req, res) => {
    requireQrPermission(req.user);
    await wa.logout(req.user._id);
    await audit(req, 'whatsapp.qr_logout', { ownerId: req.user._id });
    res.json({ ok: true });
  }),
);

router.get(
  '/events',
  ah(async (req, res) => {
    const pp = pageParams(req.query, { defLimit: 15 });
    const filter = { ownerId: req.user._id };
    const [rows, total] = await Promise.all([
      WebhookEvent.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit).lean(),
      WebhookEvent.countDocuments(filter),
    ]);
    res.json(pageResult(rows, total, pp));
  }),
);

module.exports = router;
