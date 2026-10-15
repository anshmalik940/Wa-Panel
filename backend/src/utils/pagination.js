function pageParams(query, { defLimit = 20, maxLimit = 100 } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function pageResult(data, total, { page, limit }) {
  return { data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { pageParams, pageResult, escapeRegex };
