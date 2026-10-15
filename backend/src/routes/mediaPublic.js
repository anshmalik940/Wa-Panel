const fs = require('fs');
const express = require('express');
const { Media } = require('../models');
const { filePath } = require('../utils/media');

const router = express.Router();

/** Public (token in the URL is 192 random bits) so WhatsApp / the browser can fetch the file without a login. */
router.get('/:token/:name?', async (req, res, next) => {
  try {
    if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).end();
    const m = await Media.findOne({ token: req.params.token });
    if (!m || !fs.existsSync(filePath(m))) return res.status(404).end();
    res.set({
      'Content-Type': m.mime,
      'Content-Length': String(m.size),
      'Content-Disposition': `inline; filename="${encodeURIComponent(m.originalName || m.storedName)}"`,
      'Cache-Control': 'public, max-age=86400',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    });
    return fs.createReadStream(filePath(m)).pipe(res);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
