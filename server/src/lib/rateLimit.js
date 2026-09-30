import { ApiError } from './http.js';

/**
 * In-memory sliding-window rate limiter.
 *
 * Deliberately not a fixed window: bursting 10 requests at 00:59 and 10 more
 * at 01:01 would defeat a naive counter, so we keep the timestamps instead.
 */
const buckets = new Map();

export function rateLimit({ key, limit, windowMs }) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (hits.length >= limit) {
    const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, remaining: limit - hits.length, retryAfter: 0 };
}

export function rateLimitMiddleware({ limit, windowMs, scope = 'default', by = 'ip' }) {
  return (req, res, next) => {
    const identifier =
      by === 'user' ? `u:${req.user?.id ?? 'anon'}` : `ip:${req.ip ?? req.socket?.remoteAddress}`;
    const result = rateLimit({ key: `${scope}:${identifier}`, limit, windowMs });

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return next(
        new ApiError(429, 'Too many requests — please slow down', {
          retryAfter: result.retryAfter,
        }),
      );
    }
    return next();
  };
}

/** Housekeeping so the map cannot grow without bound on a long-lived process. */
const sweeper = setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, hits] of buckets) {
    const live = hits.filter((t) => t > cutoff);
    if (live.length === 0) buckets.delete(key);
    else buckets.set(key, live);
  }
}, 5 * 60 * 1000);
sweeper.unref?.();

export default rateLimitMiddleware;
