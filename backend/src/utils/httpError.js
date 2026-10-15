class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

/** router.param helper: reject malformed ids with 404 before they reach Mongo. */
const idParam = (req, res, next, value) => (OBJECT_ID_RE.test(value) ? next() : next(new HttpError(404, 'Not found')));

module.exports = { HttpError, asyncHandler, idParam, OBJECT_ID_RE };
