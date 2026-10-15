const { ZodError } = require('zod');
const { HttpError } = require('../utils/httpError');

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {}).filter((k) => k !== 'ownerId')[0] || 'value';
    return res.status(409).json({ error: `Already exists (${field})`, details: [{ field, message: 'Must be unique' }] });
  }
  if (err && err.name === 'CastError') return res.status(400).json({ error: 'Invalid identifier or value' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large' });

  console.error('[error]', req.method, req.originalUrl, err);
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFound, errorHandler };
