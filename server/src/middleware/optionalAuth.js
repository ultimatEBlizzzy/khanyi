import { lazy } from '../db/index.js';
import { verifyToken } from '../lib/crypto.js';

/**
 * Attach `req.user` when a valid token is present — but unlike
 * `attachUser`, this also accepts a token from the query string, which is
 * what EventSource requires (the browser will not let us set headers on an
 * SSE request on every platform).
 */
const findUser = lazy(
  'SELECT id, name, email, phone, role, loyalty_points, is_active FROM users WHERE id = ?',
);

export function optionalAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && typeof req.query.token === 'string') token = req.query.token;

  if (token) {
    const claims = verifyToken(token);
    if (claims && Number.isInteger(claims.sub)) {
      const user = findUser.get(claims.sub);
      if (user && user.is_active) req.user = user;
    }
  }
  next();
}

export default optionalAuth;
