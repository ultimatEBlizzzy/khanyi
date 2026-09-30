import { lazy } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { verifyToken } from '../lib/crypto.js';

const findUser = lazy(
  `SELECT id, name, email, phone, role, loyalty_points, is_active, created_at
   FROM users WHERE id = ?`,
);

/**
 * Attach `req.user` when a valid bearer token is present.
 * Never throws — use `requireAuth` for routes that need a signed-in user.
 */
export function attachUser(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
  if (token) {
    const claims = verifyToken(token);
    if (claims && typeof claims.sub === 'number') {
      const user = findUser.get(claims.sub);
      if (user && user.is_active) req.user = user;
    }
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (!req.user) return next(ApiError.unauthorized());
  return next();
}

/** Role gate — `requireRole('admin')` or `requireRole('admin', 'driver')`. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden(`This area is for ${roles.join(' / ')} accounts`));
    }
    return next();
  };
}

export default { attachUser, requireAuth, requireRole };
