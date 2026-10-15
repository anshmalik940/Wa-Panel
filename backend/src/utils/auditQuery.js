const { AuditLog } = require('../models');
const { pageParams, pageResult, escapeRegex } = require('./pagination');

/** Lists audit entries confined by `base` (the caller's visibility) plus optional user filters. */
async function listAudit(base, query) {
  const filter = { ...base };
  const and = [];
  if (query.action) filter.action = new RegExp(`^${escapeRegex(String(query.action).slice(0, 60))}`);
  if (query.actor) filter.actorEmail = new RegExp(escapeRegex(String(query.actor).slice(0, 100)), 'i');
  const range = {};
  const from = query.from ? new Date(String(query.from)) : null;
  const to = query.to ? new Date(String(query.to)) : null;
  if (from && !Number.isNaN(from.getTime())) range.$gte = from;
  if (to && !Number.isNaN(to.getTime())) range.$lte = to;
  if (Object.keys(range).length) filter.createdAt = range;
  if (and.length) filter.$and = and;
  const pp = pageParams(query, { defLimit: 25 });
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(pp.skip).limit(pp.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return pageResult(rows, total, pp);
}

module.exports = { listAudit };
