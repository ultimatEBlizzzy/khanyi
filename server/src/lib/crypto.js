import crypto from 'node:crypto';
import config from '../config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ------------------------------- passwords ------------------------------ */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Constant-time password check. scrypt is deliberately slow, which is why
 * the login route also rate limits per identity (see lib/rateLimit.js).
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, n, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: SCRYPT.r,
      p: SCRYPT.p,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* -------------------------------- tokens -------------------------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Compact JWT-style token: base64url(payload).base64url(hmac).
 * Signed with HMAC-SHA256 over the payload, verified in constant time.
 */
export function signToken(payload, ttlSeconds = config.tokenTtlSeconds) {
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const data = b64url(JSON.stringify(body));
  const sig = b64url(crypto.createHmac('sha256', config.secret).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;

  const expected = crypto.createHmac('sha256', config.secret).update(data).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;

  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (typeof body.exp !== 'number' || body.exp < Date.now() / 1000) return null;
    return body;
  } catch {
    return null;
  }
}

/** Short, human-friendly, collision-resistant order code: KK-7F3QA2 */
export function orderCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `KK-${out}`;
}

export function randomId(prefix = '') {
  return `${prefix}${crypto.randomBytes(8).toString('hex')}`;
}
