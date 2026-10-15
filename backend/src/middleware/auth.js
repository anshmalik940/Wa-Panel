const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { User } = require('../models');
const { HttpError } = require('../utils/httpError');

function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role, tv: user.tokenVersion }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  });
}

/** Verifies the bearer token AND re-reads the user, so suspension / logout / password change take effect immediately. */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw new HttpError(401, 'Authentication required');
    let payload;
    try {
      payload = jwt.verify(token, config.JWT_SECRET);
    } catch {
      throw new HttpError(401, 'Session expired or invalid. Please sign in again.');
    }
    const user = await User.findById(payload.sub);
    if (!user || user.tokenVersion !== payload.tv) throw new HttpError(401, 'Session expired or invalid. Please sign in again.');
    if (user.status !== 'active') throw new HttpError(403, 'This account is suspended. Contact your administrator.');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'You do not have permission to perform this action'));

module.exports = { authenticate, requireRole, signToken };
