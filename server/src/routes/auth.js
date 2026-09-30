import express from 'express';
import { db, all, get, run } from '../db/index.js';
import { ApiError, asyncHandler, created, send } from '../lib/http.js';
import v from '../lib/validate.js';
import { hashPassword, verifyPassword, signToken } from '../lib/crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitMiddleware } from '../lib/rateLimit.js';
import { hub } from '../services/events.js';
import { createRiderProfile } from '../services/dispatch.js';

const router = express.Router();

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  loyaltyPoints: user.loyalty_points,
  createdAt: user.created_at,
});

const findUserByEmail = (email) => get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [email]);

/* ------------------------------- register ------------------------------- */

const registerSchema = v.object({
  name: v.string({ min: 2, max: 60 }).label('name'),
  email: v.email(),
  phone: v.phone().optional(),
  password: v.password().label('password'),
  /** Staff sign-ups are opt-in but gated: see STAFF_INVITE_CODE below. */
  wantsRider: v.bool().optional(),
});

router.post(
  '/register',
  rateLimitMiddleware({ scope: 'register', limit: 10, windowMs: 10 * 60 * 1000 }),
  asyncHandler((req, res) => {
    const body = registerSchema.parse(req.body);

    if (findUserByEmail(body.email)) {
      throw ApiError.conflict('That email already has an account — try signing in');
    }

    const info = run(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES (?, ?, ?, ?, 'customer')`,
      [body.name, body.email, body.phone ?? '', hashPassword(body.password)],
    );
    const userId = Number(info.lastInsertRowid);

    // A brand-new rider who signs up through the rider door still needs an
    // admin to switch them on shift; we only create the profile shell.
    if (body.wantsRider) {
      const invite = String(req.get('x-staff-code') ?? req.body.staffCode ?? '');
      if (invite && invite === process.env.KHANYI_STAFF_CODE) {
        run(`UPDATE users SET role = 'driver' WHERE id = ?`, [userId]);
        createRiderProfile(userId, { vehicle: 'scooter' });
      }
    }

    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    const token = signToken({ sub: user.id, role: user.role });

    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, ?, 'auth.register', 'user', ?, '{}')`,
      [user.id, user.name, String(user.id)],
    );

    return created(res, { token, user: publicUser(user) });
  }),
);

/* -------------------------------- login --------------------------------- */

const loginSchema = v.object({
  email: v.email(),
  password: v.string({ max: 128 }).label('password'),
});

router.post(
  '/login',
  // Two limits: per-IP stops a scanner, per-account stops a targeted guess.
  rateLimitMiddleware({ scope: 'login-ip', limit: 30, windowMs: 10 * 60 * 1000 }),
  asyncHandler((req, res) => {
    const body = loginSchema.parse(req.body);

    const accountLimit = rateLimitMiddleware({
      scope: `login:${body.email}`,
      limit: 8,
      windowMs: 10 * 60 * 1000,
    });
    let blocked = null;
    accountLimit(req, res, (err) => {
      blocked = err ?? null;
    });
    if (blocked) throw blocked;

    const user = findUserByEmail(body.email);
    // Same message + same work either way: never reveal which emails exist.
    const ok = user ? verifyPassword(body.password, user.password_hash) : false;
    if (!user || !ok) throw ApiError.unauthorized('Email or password is incorrect');
    if (!user.is_active) throw ApiError.forbidden('That account has been deactivated — speak to the store');

    const token = signToken({ sub: user.id, role: user.role });
    return send(res, { token, user: publicUser(user) });
  }),
);

/* --------------------------------- me ----------------------------------- */

router.get('/me', requireAuth, (req, res) => {
  const addresses = all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id', [req.user.id]);
  const stats = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS spent
       FROM orders WHERE user_id = ? AND status NOT IN ('cancelled','rejected')`,
    [req.user.id],
  );
  const driver = req.user.role === 'driver'
    ? get('SELECT id, vehicle, plate, status, rating, deliveries FROM drivers WHERE user_id = ?', [req.user.id])
    : null;

  return send(res, {
    user: publicUser(req.user),
    addresses,
    stats: { orders: stats.orders, spent: stats.spent },
    driver,
  });
});

router.patch(
  '/me',
  requireAuth,
  asyncHandler((req, res) => {
    const body = v
      .object({
        name: v.string({ min: 2, max: 60 }).optional(),
        phone: v.phone().optional(),
        currentPassword: v.string({ max: 128 }).optional(),
        newPassword: v.password().optional(),
      })
      .parse(req.body);

    if (body.newPassword) {
      const full = get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      if (!body.currentPassword || !verifyPassword(body.currentPassword, full.password_hash)) {
        throw ApiError.forbidden('Your current password is not correct');
      }
      run('UPDATE users SET password_hash = ? WHERE id = ?', [
        hashPassword(body.newPassword),
        req.user.id,
      ]);
      run(
        `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
         VALUES (?, ?, 'auth.password_change', 'user', ?, '{}')`,
        [req.user.id, req.user.name, String(req.user.id)],
      );
    }

    if (body.name !== undefined) run('UPDATE users SET name = ? WHERE id = ?', [body.name, req.user.id]);
    if (body.phone !== undefined) run('UPDATE users SET phone = ? WHERE id = ?', [body.phone, req.user.id]);

    const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    return send(res, { user: publicUser(user) });
  }),
);

/* ------------------------------ addresses ------------------------------- */

const addressSchema = v.object({
  label: v.string({ max: 30 }).optional(),
  line1: v.string({ min: 4, max: 160 }),
  suburb: v.string({ max: 80 }).optional(),
  city: v.string({ max: 80 }).optional(),
  notes: v.text({ max: 240 }).optional(),
  lat: v.number({ min: -90, max: 90 }).optional(),
  lng: v.number({ min: -180, max: 180 }).optional(),
  isDefault: v.bool().optional(),
});

router.get('/me/addresses', requireAuth, (req, res) =>
  send(res, { addresses: all('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id', [req.user.id]) }),
);

router.post(
  '/me/addresses',
  requireAuth,
  asyncHandler((req, res) => {
    const body = addressSchema.parse(req.body);
    const count = get('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [req.user.id]).n;
    const makeDefault = body.isDefault ?? count === 0;

    const info = db.transaction(() => {
      if (makeDefault) run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      return run(
        `INSERT INTO addresses (user_id, label, line1, suburb, city, notes, lat, lng, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.user.id,
          body.label ?? 'Home',
          body.line1,
          body.suburb ?? 'Malamulele',
          body.city ?? 'Malamulele',
          body.notes ?? '',
          body.lat ?? null,
          body.lng ?? null,
          makeDefault ? 1 : 0,
        ],
      );
    })();

    const address = get('SELECT * FROM addresses WHERE id = ?', [info.lastInsertRowid]);
    return created(res, { address });
  }),
);

router.patch(
  '/me/addresses/:id',
  requireAuth,
  asyncHandler((req, res) => {
    const address = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!address) throw ApiError.notFound('Address not found');

    const body = addressSchema.parse(req.body);
    db.transaction(() => {
      if (body.isDefault) run('UPDATE addresses SET is_default = 0 WHERE user_id = ?', [req.user.id]);
      run(
        `UPDATE addresses
            SET label = COALESCE(?, label),
                line1 = COALESCE(?, line1),
                suburb = COALESCE(?, suburb),
                city = COALESCE(?, city),
                notes = COALESCE(?, notes),
                lat = COALESCE(?, lat),
                lng = COALESCE(?, lng),
                is_default = COALESCE(?, is_default)
          WHERE id = ?`,
        [
          body.label ?? null,
          body.line1 ?? null,
          body.suburb ?? null,
          body.city ?? null,
          body.notes ?? null,
          body.lat ?? null,
          body.lng ?? null,
          body.isDefault === undefined ? null : body.isDefault ? 1 : 0,
          address.id,
        ],
      );
    })();

    return send(res, { address: get('SELECT * FROM addresses WHERE id = ?', [address.id]) });
  }),
);

router.delete(
  '/me/addresses/:id',
  requireAuth,
  asyncHandler((req, res) => {
    const address = get('SELECT * FROM addresses WHERE id = ? AND user_id = ?', [
      req.params.id,
      req.user.id,
    ]);
    if (!address) throw ApiError.notFound('Address not found');
    run('DELETE FROM addresses WHERE id = ?', [address.id]);
    return send(res, { ok: true });
  }),
);

/* ------------------------- loyalty (read only) -------------------------- */

router.get('/me/loyalty', requireAuth, (req, res) => {
  const user = get('SELECT loyalty_points FROM users WHERE id = ?', [req.user.id]);
  const recent = all(
    `SELECT code, points_earned, points_redeemed, total, created_at, status
       FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 15`,
    [req.user.id],
  );
  return send(res, { points: user.loyalty_points, history: recent });
});

/* ------------------------------- demo login ----------------------------- */
/** One-tap demo access for reviewers — disabled unless explicitly enabled. */
router.post(
  '/demo/:role',
  rateLimitMiddleware({ scope: 'demo', limit: 20, windowMs: 60 * 1000 }),
  asyncHandler((req, res) => {
    if (process.env.KHANYI_DEMO !== '1') {
      throw ApiError.forbidden('Demo logins are disabled');
    }
    const map = { customer: 'customer@demo.kk', driver: 'driver@demo.kk', admin: 'admin@demo.kk' };
    const email = map[req.params.role];
    if (!email) throw ApiError.notFound('Unknown demo role');

    const user = findUserByEmail(email);
    if (!user) throw ApiError.notFound('Run the seed script first');

    hub.publish([`user:${user.id}`], 'session.started', { userId: user.id, role: user.role });
    return send(res, { token: signToken({ sub: user.id, role: user.role }), user: publicUser(user) });
  }),
);

export default router;
