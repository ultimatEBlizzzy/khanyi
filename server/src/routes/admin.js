import express from 'express';
import { db, all, get, run } from '../db/index.js';
import { ApiError, asyncHandler, created, send } from '../lib/http.js';
import v from '../lib/validate.js';
import { requireRole } from '../middleware/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { hub } from '../services/events.js';
import {
  listAll, dashboardStats, getOrderById, hydrate, transition, kitchenQueue, activeDeliveries,
} from '../services/orders.js';
import {
  fullMenu, getItemDetail, setItemAvailability, setItemStock, setCategoryAvailability,
  updateItem, stockRadar,
} from '../services/menu.js';
import {
  listRiders, assignRider, autoAssign, refreshDriverStatus, driverById, deliveryAvailability,
} from '../services/dispatch.js';
import {
  getConfig, updateSettings, defaults, isNumericKey, isBooleanKey,
} from '../services/settings.js';

const router = express.Router();
router.use(requireRole('admin'));

/* ------------------------------- overview ------------------------------- */

router.get(
  '/overview',
  asyncHandler((req, res) =>
    send(res, {
      stats: dashboardStats(),
      queue: kitchenQueue(),
      deliveries: activeDeliveries(),
      riders: listRiders(),
      lowStock: stockRadar(6),
      settings: getConfig(),
      storeStatus: {
        open: getConfig().store_open === '1',
        acceptingOrders: getConfig().accepting_orders === '1',
      },
      live: hub.stats(),
      serverTime: new Date().toISOString(),
    }),
  ),
);

/* -------------------------------- orders -------------------------------- */

router.get(
  '/orders',
  asyncHandler((req, res) => {
    const { rows, total, limit, offset } = listAll({
      status: req.query.status,
      fulfilment: req.query.fulfilment,
      search: req.query.search,
      limit: Number(req.query.limit ?? 60),
      offset: Number(req.query.offset ?? 0),
    });
    return send(res, { orders: rows.map(hydrate), total, limit, offset });
  }),
);

router.get(
  '/orders/:id',
  asyncHandler((req, res) => {
    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');
    return send(res, { order: hydrate(order) });
  }),
);

router.post(
  '/orders/:id/assign',
  asyncHandler((req, res) => {
    const body = v
      .object({ driverId: v.int({ min: 1 }).optional(), auto: v.bool().optional() })
      .parse(req.body ?? {});

    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');

    if (body.auto || !body.driverId) {
      // Already on somebody's bike? Nothing to do — say so plainly instead of
      // pretending no rider could be found.
      if (order.driver_id) {
        return send(res, {
          order: hydrate(order),
          mode: 'auto',
          note: `Already assigned to ${order.driver_name}`,
        });
      }
      const assigned = autoAssign(order.id, req.user);
      if (!assigned) {
        throw ApiError.conflict('Every rider is offline or at capacity — nobody to send right now');
      }
      return send(res, { order: assigned, mode: 'auto' });
    }
    const updated = assignRider(order.id, { driverId: body.driverId, actor: req.user, force: true });
    return send(res, { order: updated, mode: 'manual' });
  }),
);

/** Kitchen ticket: bump an order to the next sensible state in one tap. */
router.post(
  '/orders/:id/bump',
  asyncHandler(async (req, res) => {
    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');

    const next = {
      pending: 'confirmed',
      confirmed: 'preparing',
      preparing: 'ready',
      ready: order.fulfilment === 'collection' ? 'completed' : null,
      assigned: 'picked_up',
      picked_up: 'on_the_way',
      on_the_way: 'delivered',
      delivered: 'completed',
    }[order.status];

    if (!next) {
      throw ApiError.conflict(
        order.fulfilment === 'delivery' && order.status === 'ready'
          ? 'Assign a rider to move this delivery on'
          : 'That order has nowhere left to go',
      );
    }

    const withDriver = next === 'assigned' ? (await autoAssignOrder(order, req.user)) : null;
    const fresh = withDriver ?? transition(order.id, next, { actor: req.user, note: 'Kitchen bump' });
    if (fresh.driver_id) refreshDriverStatus(fresh.driver_id);
    return send(res, { order: fresh, movedTo: next });
  }),
);

async function autoAssignOrder(order, actor) {
  const assigned = autoAssign(order.id, actor);
  if (!assigned) {
    throw ApiError.conflict('This delivery needs a rider — none is available right now');
  }
  return assigned;
}

/* --------------------------------- menu --------------------------------- */

router.get(
  '/menu',
  asyncHandler((req, res) =>
    send(res, {
      categories: fullMenu({ includeUnavailable: true }),
      lowStock: stockRadar(8),
    }),
  ),
);

router.patch(
  '/menu/items/:id',
  asyncHandler((req, res) => {
    const body = v
      .object({
        name: v.string({ min: 2, max: 80 }).optional(),
        description: v.text({ max: 400 }).optional(),
        base_price: v.int({ min: 0, max: 500000 }).optional(),
        prep_minutes: v.int({ min: 1, max: 180 }).optional(),
        badge: v.string({ max: 24 }).optional(),
        is_available: v.bool().optional(),
        track_stock: v.bool().optional(),
        stock: v.int({ min: 0, max: 100000 }).optional(),
      })
      .parse(req.body);

    let item = getItemDetail(Number(req.params.id));

    if (body.is_available !== undefined) item = setItemAvailability(item.id, body.is_available, req.user);
    if (body.track_stock !== undefined || body.stock !== undefined) {
      item = setItemStock(item.id, { stock: body.stock, trackStock: body.track_stock }, req.user);
    }

    const rest = { name: body.name, description: body.description, base_price: body.base_price, prep_minutes: body.prep_minutes, badge: body.badge };
    if (Object.values(rest).some((value) => value !== undefined)) {
      item = updateItem(item.id, rest, req.user);
    }

    return send(res, { item });
  }),
);

router.patch(
  '/menu/categories/:id/availability',
  asyncHandler((req, res) => {
    const body = v.object({ is_available: v.bool() }).parse(req.body);
    const category = get('SELECT * FROM categories WHERE id = ?', [req.params.id]);
    if (!category) throw ApiError.notFound('Category not found');
    return send(res, {
      menu: setCategoryAvailability(category.id, body.is_available, req.user),
      category: category.name,
      isAvailable: body.is_available,
    });
  }),
);

/* -------------------------------- riders -------------------------------- */

/** The dispatch board: who is on shift, who is busy, who can take a run. */
router.get(
  '/riders',
  asyncHandler((req, res) =>
    send(res, { riders: listRiders(), availability: deliveryAvailability() }),
  ),
);

/** Onboard a rider: creates the login and the rider profile in one step. */
router.post(
  '/riders',
  asyncHandler((req, res) => {
    const body = v
      .object({
        name: v.string({ min: 2, max: 60 }),
        email: v.email(),
        phone: v.phone(),
        password: v.password(),
        vehicle: v.enum(['bike', 'scooter', 'car']).optional(),
        plate: v.string({ max: 16 }).optional(),
        zone: v.string({ max: 40 }).optional(),
      })
      .parse(req.body);

    if (get('SELECT id FROM users WHERE email = ? COLLATE NOCASE', [body.email])) {
      throw ApiError.conflict('That email is already registered');
    }

    const result = db.transaction(() => {
      const info = run(
        `INSERT INTO users (name, email, phone, password_hash, role)
         VALUES (?, ?, ?, ?, 'driver')`,
        [body.name, body.email, body.phone, hashPassword(body.password)],
      );
      const userId = Number(info.lastInsertRowid);
      run(
        `INSERT INTO drivers (user_id, vehicle, plate, zone, status) VALUES (?, ?, ?, ?, 'online')`,
        [userId, body.vehicle ?? 'scooter', body.plate ?? '', body.zone ?? 'Malamulele'],
      );
      run(
        `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
         VALUES (?, ?, 'rider.create', 'user', ?, ?)`,
        [req.user.id, req.user.name, String(userId), JSON.stringify({ vehicle: body.vehicle ?? 'scooter' })],
      );
      return get('SELECT * FROM drivers WHERE user_id = ?', [userId]);
    })();

    hub.publish(['admin', 'drivers'], 'rider.joined', { driverId: result.id, name: body.name });
    return created(res, { rider: listRiders().find((r) => r.id === result.id) });
  }),
);

router.patch(
  '/riders/:id',
  asyncHandler((req, res) => {
    const body = v
      .object({
        status: v.enum(['offline', 'online', 'busy']).optional(),
        vehicle: v.enum(['bike', 'scooter', 'car']).optional(),
        plate: v.string({ max: 16 }).optional(),
        zone: v.string({ max: 40 }).optional(),
        is_active: v.bool().optional(),
      })
      .parse(req.body);

    const driver = driverById(Number(req.params.id));
    if (!driver) throw ApiError.notFound('Rider not found');

    if (body.status && body.status === 'offline') {
      const active = get(
        `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status IN ('assigned','picked_up','on_the_way')`,
        [driver.id],
      ).n;
      if (active > 0) throw ApiError.conflict('Finish the open runs before switching this rider offline');
    }

    run(
      `UPDATE drivers
          SET status = COALESCE(?, status),
              vehicle = COALESCE(?, vehicle),
              plate = COALESCE(?, plate),
              zone = COALESCE(?, zone)
        WHERE id = ?`,
      [body.status ?? null, body.vehicle ?? null, body.plate ?? null, body.zone ?? null, driver.id],
    );
    if (body.is_active !== undefined) {
      run('UPDATE users SET is_active = ? WHERE id = ?', [body.is_active ? 1 : 0, driver.user_id]);
    }

    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, ?, 'rider.update', 'driver', ?, ?)`,
      [req.user.id, req.user.name, String(driver.id), JSON.stringify(body)],
    );
    hub.publish(['admin', 'drivers'], 'rider.updated', { driverId: driver.id, ...body });

    return send(res, { rider: listRiders().find((r) => r.id === driver.id) });
  }),
);

/* ------------------------------- settings ------------------------------- */

router.get(
  '/settings',
  asyncHandler((req, res) =>
    send(res, { settings: getConfig(), defaults, riders: listRiders().length }),
  ),
);

router.patch(
  '/settings',
  asyncHandler((req, res) => {
    const schema = v.object(
      Object.fromEntries(
        Object.keys(defaults).map((key) => {
          if (isBooleanKey(key)) return [key, v.bool().optional()];
          if (isNumericKey(key)) {
            const isLat = key === 'store_lat';
            const isLng = key === 'store_lng';
            return [
              key,
              v.number({
                min: isLat ? -90 : isLng ? -180 : 0,
                max: isLat ? 90 : isLng ? 180 : 1_000_000,
              }).optional(),
            ];
          }
          return [key, v.string({ max: 400 }).optional()];
        }),
      ),
    );

    const patch = schema.parse(req.body);
    // Booleans become 1/0 for storage.
    const normalised = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, typeof value === 'boolean' ? (value ? '1' : '0') : value]),
    );
    const settings = updateSettings(normalised, req.user);

    hub.publish(['admin', 'staff', 'orders'], 'store.updated', { settings });
    return send(res, { settings });
  }),
);

/** One-tap trading switches — close the shop, pause orders, ride auto-assign. */
router.post(
  '/settings/toggle',
  asyncHandler((req, res) => {
    const body = v
      .object({ key: v.enum(['store_open', 'accepting_orders', 'auto_assign_riders']), value: v.bool() })
      .parse(req.body);
    const settings = updateSettings({ [body.key]: body.value ? '1' : '0' }, req.user);
    hub.publish(['admin', 'staff', 'orders', 'public'], 'store.updated', {
      key: body.key,
      value: body.value,
    });
    return send(res, { settings, key: body.key, value: body.value });
  }),
);

/* ------------------------------- catalogue ------------------------------ */

router.post(
  '/menu/items',
  asyncHandler((req, res) => {
    const body = v
      .object({
        categoryId: v.int({ min: 1 }),
        name: v.string({ min: 2, max: 80 }),
        description: v.text({ max: 400 }).optional(),
        basePrice: v.int({ min: 0, max: 500000 }),
        image: v.string({ max: 300 }).optional(),
        badge: v.string({ max: 24 }).optional(),
        prepMinutes: v.int({ min: 1, max: 180 }).optional(),
        trackStock: v.bool().optional(),
        stock: v.int({ min: 0, max: 100000 }).optional(),
      })
      .parse(req.body);

    const category = get('SELECT * FROM categories WHERE id = ?', [body.categoryId]);
    if (!category) throw ApiError.unprocessable('Pick a category that exists');

    const slug = `${body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Date.now().toString(36)}`;
    const info = run(
      `INSERT INTO menu_items (category_id, slug, name, description, base_price, image, badge, prep_minutes, track_stock, stock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.categoryId, slug, body.name, body.description ?? '', body.basePrice,
        body.image ?? '', body.badge ?? '', body.prepMinutes ?? 10,
        body.trackStock ? 1 : 0, body.stock ?? 0,
      ],
    );

    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, ?, 'menu.create', 'menu_item', ?, ?)`,
      [req.user.id, req.user.name, String(info.lastInsertRowid), JSON.stringify({ name: body.name, price: body.basePrice })],
    );
    hub.publish(['store', 'staff'], 'menu.updated', { itemId: Number(info.lastInsertRowid), name: body.name });

    return created(res, { item: getItemDetail(Number(info.lastInsertRowid)) });
  }),
);

/* -------------------------------- promos -------------------------------- */

router.get(
  '/promos',
  asyncHandler((req, res) => send(res, { promos: all('SELECT * FROM promos ORDER BY id DESC') })),
);

router.post(
  '/promos',
  asyncHandler((req, res) => {
    const body = v
      .object({
        code: v.string({ min: 3, max: 20, pattern: /^[A-Za-z0-9_-]+$/ }),
        kind: v.enum(['percent', 'fixed', 'free_delivery']),
        value: v.int({ min: 0, max: 100000 }).optional(),
        minSubtotal: v.int({ min: 0, max: 1000000 }).optional(),
        maxUses: v.int({ min: 0, max: 100000 }).optional(),
        description: v.text({ max: 160 }).optional(),
        expiresAt: v.string({ max: 32 }).optional(),
      })
      .parse(req.body);

    if (body.kind === 'percent' && (body.value ?? 0) > 90) {
      throw ApiError.unprocessable('A percentage discount above 90% looks like a typo');
    }
    if (get('SELECT id FROM promos WHERE code = ? COLLATE NOCASE', [body.code])) {
      throw ApiError.conflict('That promo code already exists');
    }

    const info = run(
      `INSERT INTO promos (code, kind, value, min_subtotal, max_uses, description, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code.toUpperCase(), body.kind, body.value ?? 0, body.minSubtotal ?? 0,
        body.maxUses ?? 0, body.description ?? '', body.expiresAt ?? null,
      ],
    );
    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, ?, 'promo.create', 'promo', ?, ?)`,
      [req.user.id, req.user.name, String(info.lastInsertRowid), JSON.stringify({ code: body.code })],
    );
    hub.publish(['admin', 'public'], 'promo.updated', { code: body.code.toUpperCase() });
    return created(res, { promo: get('SELECT * FROM promos WHERE id = ?', [info.lastInsertRowid]) });
  }),
);

router.patch(
  '/promos/:id',
  asyncHandler((req, res) => {
    const body = v.object({ is_active: v.bool().optional(), max_uses: v.int({ min: 0 }).optional() }).parse(req.body);
    const promo = get('SELECT * FROM promos WHERE id = ?', [req.params.id]);
    if (!promo) throw ApiError.notFound('Promo not found');
    run(
      `UPDATE promos SET is_active = COALESCE(?, is_active), max_uses = COALESCE(?, max_uses) WHERE id = ?`,
      [body.is_active === undefined ? null : body.is_active ? 1 : 0, body.max_uses ?? null, promo.id],
    );
    hub.publish(['admin', 'public'], 'promo.updated', { code: promo.code, active: body.is_active });
    return send(res, { promo: get('SELECT * FROM promos WHERE id = ?', [promo.id]) });
  }),
);

/* ------------------------------- customers ------------------------------ */

router.get(
  '/customers',
  asyncHandler((req, res) => {
    const customers = all(
      `SELECT u.id, u.name, u.email, u.phone, u.loyalty_points, u.created_at, u.is_active,
              COUNT(o.id) AS orders,
              COALESCE(SUM(CASE WHEN o.status NOT IN ('cancelled','rejected') THEN o.total ELSE 0 END), 0) AS spent,
              MAX(o.created_at) AS last_order
         FROM users u
         LEFT JOIN orders o ON o.user_id = u.id
        WHERE u.role = 'customer'
        GROUP BY u.id
        ORDER BY spent DESC, u.id DESC
        LIMIT 100`,
    );
    return send(res, { customers });
  }),
);

router.patch(
  '/customers/:id',
  asyncHandler((req, res) => {
    const body = v.object({ is_active: v.bool().optional(), loyalty_points: v.int({ min: 0, max: 1000000 }).optional() }).parse(req.body);
    const customer = get(`SELECT * FROM users WHERE id = ? AND role = 'customer'`, [req.params.id]);
    if (!customer) throw ApiError.notFound('Customer not found');

    run(
      `UPDATE users SET is_active = COALESCE(?, is_active), loyalty_points = COALESCE(?, loyalty_points) WHERE id = ?`,
      [body.is_active === undefined ? null : body.is_active ? 1 : 0, body.loyalty_points ?? null, customer.id],
    );
    return send(res, { customer: get('SELECT id, name, email, is_active, loyalty_points FROM users WHERE id = ?', [customer.id]) });
  }),
);

/* --------------------------------- audit -------------------------------- */

router.get(
  '/audit',
  asyncHandler((req, res) => {
    const limit = Math.min(200, Number(req.query.limit ?? 60));
    return send(res, {
      entries: all(
        `SELECT * FROM audit_log ORDER BY id DESC LIMIT ?`,
        [Number.isFinite(limit) ? limit : 60],
      ),
    });
  }),
);

/** Manual reconciliation: recompute every order total from its lines. */
router.post(
  '/reconcile',
  asyncHandler((req, res) => {
    const orders = all(`SELECT id, subtotal, delivery_fee, discount FROM orders`);
    const drift = [];
    const fix = db.prepare(
      `UPDATE orders SET subtotal = ?, total = MAX(0, ? - ?) + ? WHERE id = ?`,
    );

    db.transaction(() => {
      for (const order of orders) {
        const sum = get(
          'SELECT COALESCE(SUM(line_total),0) AS subtotal FROM order_items WHERE order_id = ?',
          [order.id],
        ).subtotal;
        if (sum !== order.subtotal) {
          drift.push({ orderId: order.id, stored: order.subtotal, computed: sum });
          fix.run(sum, sum, order.discount, order.delivery_fee, order.id);
        }
      }
    })();

    return send(res, { checked: orders.length, corrected: drift.length, drift });
  }),
);

export default router;
