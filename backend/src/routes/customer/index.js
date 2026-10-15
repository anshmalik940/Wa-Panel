const express = require('express');
const { authenticate, requireRole } = require('../../middleware/auth');

const router = express.Router();
// customers (final clients) and resellers (who also run their own campaigns) share this workspace API.
// Every query inside is scoped by ownerId = the signed-in user, so tenants never see each other.
router.use(authenticate, requireRole('customer', 'reseller'));
router.use('/contacts', require('./contacts'));
router.use('/templates', require('./templates'));
router.use('/campaigns', require('./campaigns'));
router.use('/whatsapp', require('./whatsapp'));
router.use('/media', require('./media'));
router.use('/voice', require('./voice'));
router.use('/', require('./dashboard'));

module.exports = router;
