const { AuditLog } = require('../models');

/**
 * Records an audit entry. Never throws (an audit failure must not break the action),
 * but failures are logged loudly rather than swallowed silently.
 */
async function audit(req, action, { targetType = '', targetId = '', ownerId = null, meta = {} } = {}) {
  try {
    const actor = req && req.user;
    await AuditLog.create({
      actorId: actor ? actor._id : null,
      actorEmail: actor ? actor.email : 'system',
      actorRole: actor ? actor.role : 'system',
      action,
      targetType,
      targetId: targetId ? String(targetId) : '',
      ownerId,
      meta,
      ip: req && req.ip ? req.ip : '',
    });
  } catch (err) {
    console.error('[audit] failed to write audit log', action, err);
  }
}

module.exports = { audit };
