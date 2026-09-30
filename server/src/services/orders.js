import { db, all, get, run, settingInt } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { orderCode } from '../lib/crypto.js';
import { hub, STATUS_LABELS } from './events.js';
import { priceCart } from './pricing.js';
import { getTunables } from './settings.js';

/* ------------------------------------------------------------------ *
 * State machine
 * ------------------------------------------------------------------ */

/**
 * Every legal move an order can make. Anything not listed here is refused,
 * which is what keeps a raced "cancel" from resurrecting a delivered order.
 */
export const TRANSITIONS = {
  pending: ['confirmed', 'cancelled', 'rejected'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['assigned', 'completed', 'cancelled'],
  assigned: ['picked_up', 'ready', 'cancelled'],
  picked_up: ['on_the_way', 'delivered', 'cancelled'],
  on_the_way: ['delivered', 'cancelled'],
  delivered: ['completed'],
  completed: [],
  cancelled: [],
  rejected: [],
};

/** Who may perform which move. */
const ACTOR_RULES = {
  confirmed: ['admin'],
  preparing: ['admin'],
  ready: ['admin'],
  assigned: ['admin', 'system'],
  picked_up: ['driver', 'admin'],
  on_the_way: ['driver', 'admin'],
  delivered: ['driver', 'admin'],
  completed: ['admin', 'customer'],
  cancelled: ['admin', 'customer'],
  rejected: ['admin'],
};

const TIMESTAMP_FIELD = {
  confirmed: 'confirmed_at',
  ready: 'ready_at',
  picked_up: 'dispatched_at',
  delivered: 'completed_at',
  completed: 'completed_at',
  cancelled: 'cancelled_at',
  rejected: 'cancelled_at',
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function mayAct(role, to) {
  return (ACTOR_RULES[to] ?? []).includes(role);
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

const ORDER_SELECT = `
  SELECT o.*,
         u.name  AS customer_email_name,
         u.email AS customer_email,
         d.vehicle AS driver_vehicle,
         d.plate   AS driver_plate,
         du.name   AS driver_name,
         du.phone  AS driver_phone,
         (SELECT COUNT(*) FROM ratings r WHERE r.order_id = o.id) AS has_rating
  FROM orders o
  JOIN users u ON u.id = o.user_id
  LEFT JOIN drivers d ON d.id = o.driver_id
  LEFT JOIN users du ON du.id = d.user_id
`;

export function orderItems(orderId) {
  return all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [orderId]).map((row) => ({
    ...row,
    options: safeParse(row.options_json, []),
  }));
}

export function orderEvents(orderId) {
  return all('SELECT * FROM order_events WHERE order_id = ? ORDER BY id', [orderId]);
}

export function hydrate(order) {
  if (!order) return null;
  return {
    ...order,
    fulfilment: order.fulfilment,
    statusLabel: STATUS_LABELS[order.status] ?? order.status,
    items: orderItems(order.id),
    events: orderEvents(order.id),
    timeline: timelineFor(order),
    driver: order.driver_id
      ? {
          id: order.driver_id,
          name: order.driver_name,
          phone: order.driver_phone,
          vehicle: order.driver_vehicle,
          plate: order.driver_plate,
        }
      : null,
  };
}

export function timelineFor(order) {
  const steps = order.fulfilment === 'delivery'
    ? ['pending', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'delivered', 'completed']
    : ['pending', 'confirmed', 'preparing', 'ready', 'completed'];

  if (['cancelled', 'rejected'].includes(order.status)) {
    return { steps: [...steps, order.status], currentIndex: steps.length, cancelled: true };
  }
  const index = steps.indexOf(order.status);
  return { steps, currentIndex: index === -1 ? 0 : index, cancelled: false, labels: STATUS_LABELS };
}

export function getOrderById(id) {
  return get(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
}

export function getOrderByCode(code) {
  return get(`${ORDER_SELECT} WHERE o.code = ? COLLATE NOCASE`, [code]);
}

export function assertCanView(order, user) {
  if (!order) throw ApiError.notFound('We could not find that order');
  if (!user) throw ApiError.unauthorized();
  if (user.role === 'admin') return order;
  if (order.user_id === user.id) return order;
  if (user.role === 'driver') {
    const driver = get('SELECT id FROM drivers WHERE user_id = ?', [user.id]);
    // A rider may see an unassigned ready order (to claim it) or their own.
    if (driver && (order.driver_id === driver.id || (order.status === 'ready' && !order.driver_id))) {
      return order;
    }
  }
  throw ApiError.forbidden('That order belongs to somebody else');
}

/* ------------------------------------------------------------------ *
 * Create
 * ------------------------------------------------------------------ */

export function createOrder({ user, payload, idempotencyKey = null, actor = null }) {
  const tunables = getTunables();
  const fulfilment = payload.fulfilment === 'delivery' ? 'delivery' : 'collection';

  if (!tunables.storeOpen) {
    throw ApiError.conflict('The kitchen is closed right now — check back at 06:00');
  }
  if (!tunables.acceptingOrders) {
    throw ApiError.conflict('We have paused new orders for a moment — please try again shortly');
  }

  // Replayed request? Hand back the original order untouched.
  if (idempotencyKey) {
    const existing = get('SELECT id FROM orders WHERE idempotency_key = ?', [idempotencyKey]);
    if (existing) return { order: hydrate(getOrderById(existing.id)), replayed: true };
  }

  let address = payload.address ?? null;
  if (fulfilment === 'delivery') {
    if (!address || !String(address.line1 ?? '').trim()) {
      throw ApiError.unprocessable('We need a delivery address before the rider can leave', {
        field: 'address',
      });
    }
    address = {
      line1: String(address.line1).slice(0, 160),
      suburb: String(address.suburb ?? 'Malamulele').slice(0, 80),
      notes: String(address.notes ?? '').slice(0, 240),
      lat: Number.isFinite(Number(address.lat)) ? Number(address.lat) : null,
      lng: Number.isFinite(Number(address.lng)) ? Number(address.lng) : null,
    };
  }

  const quote = priceCart({
    items: payload.items ?? payload.lines ?? [],
    fulfilment,
    address,
    promoCode: payload.promoCode ?? '',
    redeemPoints: payload.redeemPoints ?? 0,
    user,
    tunables,
  });

  if (!quote.canCheckout) {
    const firstError = quote.issues.find((i) => i.type === 'error');
    throw ApiError.unprocessable(firstError?.message ?? 'We could not price that basket', {
      issues: quote.issues,
    });
  }

  const transaction = db.transaction(() => {
    const code = uniqueCode();

    const info = run(
      `INSERT INTO orders (
         code, user_id, fulfilment, status, subtotal, delivery_fee, discount, total,
         payment_method, promo_code, points_earned, points_redeemed,
         customer_name, customer_phone, address_line, address_suburb, address_notes,
         lat, lng, distance_km, eta_minutes, notes, idempotency_key
       ) VALUES (
         ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
      [
        code,
        user.id,
        fulfilment,
        quote.subtotal,
        quote.deliveryFee,
        quote.discount,
        quote.total,
        ['cash', 'card', 'eft', 'snapscan'].includes(payload.paymentMethod) ? payload.paymentMethod : 'cash',
        quote.promo?.code ?? '',
        quote.pointsEarned,
        quote.pointsUsed,
        String(payload.customerName ?? user.name).slice(0, 80),
        String(payload.customerPhone ?? user.phone ?? '').slice(0, 24),
        address?.line1 ?? '',
        address?.suburb ?? '',
        address?.notes ?? '',
        address?.lat ?? null,
        address?.lng ?? null,
        quote.distanceKm,
        quote.etaMinutes,
        String(payload.notes ?? '').slice(0, 300),
        idempotencyKey,
      ],
    );

    const orderId = info.lastInsertRowid;

    const insertLine = db.prepare(
      `INSERT INTO order_items (order_id, item_id, name, unit_price, qty, line_total, options_json, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of quote.lines) {
      insertLine.run(
        orderId,
        line.itemId,
        line.name,
        line.unitPrice,
        line.qty,
        line.lineTotal,
        JSON.stringify(line.options ?? []),
        line.notes ?? '',
      );
    }

    // Reserve stock for anything the kitchen counts down.
    const decrement = db.prepare(
      `UPDATE menu_items
          SET stock = MAX(0, stock - ?), updated_at = datetime('now')
        WHERE id = ? AND track_stock = 1`,
    );
    for (const line of quote.lines) decrement.run(line.qty, line.itemId);

    // Redeemed points leave the balance immediately; earned points land on
    // completion so a cancelled order cannot mint loyalty currency.
    if (quote.pointsUsed > 0) {
      run('UPDATE users SET loyalty_points = MAX(0, loyalty_points - ?) WHERE id = ?', [
        quote.pointsUsed,
        user.id,
      ]);
    }

    if (quote.promo?.code) {
      run('UPDATE promos SET uses = uses + 1 WHERE code = ? COLLATE NOCASE', [quote.promo.code]);
    }

    writeEvent(orderId, null, 'pending', actor ?? user, `Order placed · ${fulfilment}`);
    writeAudit(actor ?? user, 'order.create', orderId, {
      code,
      total: quote.total,
      fulfilment,
      lines: quote.lines.length,
    });

    return orderId;
  });

  const orderId = transaction();
  const order = hydrate(getOrderById(orderId));

  // Tell the kitchen tablet and the admin console at once.
  hub.publish(['orders', 'staff', 'admin'], 'order.created', {
    orderId,
    code: order.code,
    status: order.status,
    fulfilment,
    total: order.total,
    customer: order.customer_name,
    etaMinutes: order.eta_minutes,
    items: order.items.map((i) => ({ name: i.name, qty: i.qty })),
  });
  hub.publish([`user:${user.id}`], 'order.updated', { orderId, status: 'pending', code: order.code });

  return { order, replayed: false };
}

function uniqueCode() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = orderCode();
    if (!get('SELECT 1 AS x FROM orders WHERE code = ?', [code])) return code;
  }
  throw new Error('Could not allocate an order code');
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export function transition(orderId, to, { actor, note = '', driverId, reason = '' }) {
  const order = getOrderById(orderId);
  if (!order) throw ApiError.notFound('Order not found');

  // Identity first: never leak the state of somebody else's order.
  if (actor?.role === 'customer') {
    if (order.user_id !== actor.id) throw ApiError.forbidden('That order belongs to somebody else');
    if (to !== 'cancelled' && to !== 'completed') {
      throw ApiError.forbidden('You cannot change that part of the order');
    }
    if (to === 'completed' && order.fulfilment === 'delivery') {
      throw ApiError.forbidden('The rider marks a delivery as delivered');
    }
  }

  if (actor?.role === 'driver') {
    const driver = get('SELECT id, status FROM drivers WHERE user_id = ?', [actor.id]);
    if (!driver) throw ApiError.forbidden('No rider profile linked to this account');
    if (order.driver_id !== driver.id) {
      if (!(to === 'assigned' && order.status === 'ready' && !order.driver_id)) {
        throw ApiError.forbidden('That order is not assigned to you');
      }
    }
  }

  // Then domain sense, so a tap on the wrong button reads plainly.
  if (to === 'assigned' && order.fulfilment !== 'delivery') {
    throw ApiError.unprocessable('Collection orders do not get a rider');
  }
  if (['picked_up', 'on_the_way', 'delivered'].includes(to) && order.fulfilment !== 'delivery') {
    throw ApiError.unprocessable('That step only applies to delivery orders');
  }
  if (to === 'completed' && order.fulfilment === 'delivery' && order.status !== 'delivered') {
    throw ApiError.unprocessable('A delivery closes out once the rider has marked it delivered');
  }

  // Then the state machine, then who is allowed to do it.
  if (!canTransition(order.status, to)) {
    throw ApiError.conflict(
      `An order that is "${STATUS_LABELS[order.status] ?? order.status}" cannot become "${STATUS_LABELS[to] ?? to}"`,
      { from: order.status, to },
    );
  }
  if (actor && !mayAct(actor.role, to)) {
    throw ApiError.forbidden(`A ${actor.role} cannot mark an order as "${STATUS_LABELS[to] ?? to}"`);
  }
  if (to === 'cancelled' && ['completed', 'delivered'].includes(order.status)) {
    throw ApiError.conflict('That order is already finished');
  }

  const assigneeId = to === 'assigned' ? (driverId ?? order.driver_id) : order.driver_id;
  if (to === 'assigned' && !assigneeId) {
    throw ApiError.unprocessable('Pick a rider before assigning this order');
  }

  const stamp = TIMESTAMP_FIELD[to];
  db.transaction(() => {
    const sets = [`status = ?`, `updated_at = datetime('now')`];
    const params = [to];

    if (to === 'assigned') { sets.push('driver_id = ?'); params.push(assigneeId); }
    if (stamp) { sets.push(`${stamp} = datetime('now')`); }
    if (to === 'cancelled' || to === 'rejected') {
      sets.push('cancel_reason = ?');
      params.push(String(reason || note).slice(0, 240));
    }

    run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, [...params, order.id]);

    if (to === 'cancelled' || to === 'rejected') restoreReservedStock(order.id);

    if (to === 'completed' && order.points_earned > 0) {
      run('UPDATE users SET loyalty_points = loyalty_points + ? WHERE id = ?', [
        order.points_earned,
        order.user_id,
      ]);
    }
    if (to === 'delivered' && order.driver_id) {
      run(`UPDATE drivers SET deliveries = deliveries + 1, status = 'online' WHERE id = ?`, [
        order.driver_id,
      ]);
    }

    writeEvent(order.id, order.status, to, actor, note || reason);
    writeAudit(actor, `order.${to}`, order.id, { from: order.status, note, reason });
  })();

  const fresh = hydrate(getOrderById(order.id));

  hub.publish(['orders', 'staff', 'admin', `user:${order.user_id}`], 'order.updated', {
    orderId: order.id,
    code: order.code,
    from: order.status,
    status: to,
    statusLabel: STATUS_LABELS[to],
    fulfilment: order.fulfilment,
    etaMinutes: order.eta_minutes,
    driverId: fresh.driver_id,
    driverName: fresh.driver?.name ?? null,
    note,
  });

  if (to === 'ready') {
    hub.publish(['drivers', 'admin'], 'order.ready_for_pickup', {
      orderId: order.id,
      code: order.code,
      fulfilment: order.fulfilment,
      addressLine: order.address_line,
      suburb: order.address_suburb,
      distanceKm: order.distance_km,
      total: order.total,
    });
  }

  if (to === 'assigned') {
    const driver = get('SELECT user_id FROM drivers WHERE id = ?', [assigneeId]);
    if (driver) {
      hub.publish([`user:${driver.user_id}`, 'drivers'], 'order.assigned', {
        orderId: order.id,
        code: order.code,
        addressLine: order.address_line,
        suburb: order.address_suburb,
        total: order.total,
        fee: order.delivery_fee,
      });
    }
    run(`UPDATE drivers SET status = 'busy' WHERE id = ?`, [assigneeId]);
  }

  return fresh;
}

function restoreReservedStock(orderId) {
  const lines = all(
    `SELECT oi.item_id, oi.qty
       FROM order_items oi
       JOIN menu_items mi ON mi.id = oi.item_id
      WHERE oi.order_id = ? AND mi.track_stock = 1`,
    [orderId],
  );
  const restore = db.prepare(
    `UPDATE menu_items SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?`,
  );
  for (const line of lines) restore.run(line.qty, line.item_id);
}

function writeEvent(orderId, from, to, actor, note = '') {
  run(
    `INSERT INTO order_events (order_id, from_state, to_state, actor_name, actor_role, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      orderId,
      from,
      to,
      actor?.name ?? 'system',
      actor?.role ?? 'system',
      String(note ?? '').slice(0, 240),
    ],
  );
}

function writeAudit(actor, action, orderId, meta) {
  run(
    `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
     VALUES (?, ?, ?, 'order', ?, ?)`,
    [actor?.id ?? null, actor?.name ?? 'system', action, String(orderId), JSON.stringify(meta)],
  );
}

/* ------------------------------------------------------------------ *
 * Reads used by the three consoles
 * ------------------------------------------------------------------ */

export function listForUser(userId, { limit = 30 } = {}) {
  return all(
    `${ORDER_SELECT} WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`,
    [userId, Math.min(100, limit)],
  ).map((order) => ({
    ...order,
    statusLabel: STATUS_LABELS[order.status] ?? order.status,
    items: orderItems(order.id),
    driver: order.driver_id
      ? { name: order.driver_name, phone: order.driver_phone, vehicle: order.driver_vehicle, plate: order.driver_plate }
      : null,
  }));
}

export function kitchenQueue() {
  const rows = all(
    `${ORDER_SELECT}
      WHERE o.status IN ('pending','confirmed','preparing','ready')
      ORDER BY CASE o.status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'preparing' THEN 2 ELSE 3 END,
               o.id ASC
      LIMIT 60`,
  );
  return rows.map((order) => ({
    ...order,
    statusLabel: STATUS_LABELS[order.status] ?? order.status,
    items: orderItems(order.id),
    waitMinutes: minutesSince(order.created_at),
    late: minutesSince(order.created_at) > 25,
  }));
}

export function activeDeliveries() {
  const rows = all(
    `${ORDER_SELECT}
      WHERE o.fulfilment = 'delivery'
        AND o.status IN ('ready','assigned','picked_up','on_the_way')
      ORDER BY o.id ASC`,
  );
  return rows.map((order) => ({
    ...order,
    statusLabel: STATUS_LABELS[order.status] ?? order.status,
    items: orderItems(order.id),
    durationMinutes: minutesSince(order.created_at),
  }));
}

export function listAll({ status, fulfilment, search, limit = 60, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('o.status = ?'); params.push(status); }
  if (fulfilment) { clauses.push('o.fulfilment = ?'); params.push(fulfilment); }
  if (search) {
    clauses.push('(o.code LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)');
    const like = `%${String(search).slice(0, 40)}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    `${ORDER_SELECT} ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(200, limit), Math.max(0, offset)],
  );
  const total = get(`SELECT COUNT(*) AS n FROM orders o ${where}`, params).n;
  return { rows, total, limit, offset };
}

/* ------------------------------------------------------------------ *
 * Analytics
 * ------------------------------------------------------------------ */

export function dashboardStats() {
  const today = get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(total), 0) AS revenue,
            COALESCE(AVG(total), 0) AS avg_ticket
       FROM orders
      WHERE date(created_at) = date('now') AND status NOT IN ('cancelled','rejected')`,
  );

  const live = get(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)   AS pending,
       SUM(CASE WHEN status IN ('confirmed','preparing') THEN 1 ELSE 0 END) AS in_kitchen,
       SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END)     AS ready,
       SUM(CASE WHEN status IN ('assigned','picked_up','on_the_way') THEN 1 ELSE 0 END) AS on_the_road,
       COUNT(*) AS active
     FROM orders
     WHERE status IN ('pending','confirmed','preparing','ready','assigned','picked_up','on_the_way')`,
  );

  const allTime = get(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
       FROM orders WHERE status NOT IN ('cancelled','rejected')`,
  );

  const byFulfilment = all(
    `SELECT fulfilment, COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue
       FROM orders WHERE status NOT IN ('cancelled','rejected')
      GROUP BY fulfilment`,
  );

  const topItems = all(
    `SELECT oi.name,
            SUM(oi.qty) AS qty,
            SUM(oi.line_total) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.status NOT IN ('cancelled','rejected')
      GROUP BY oi.name
      ORDER BY qty DESC
      LIMIT 6`,
  );

  const last14 = all(
    `SELECT date(created_at) AS day,
            COUNT(*) AS orders,
            COALESCE(SUM(total),0) AS revenue
       FROM orders
      WHERE created_at >= datetime('now','-14 days') AND status NOT IN ('cancelled','rejected')
      GROUP BY day ORDER BY day`,
  );

  const hourly = all(
    `SELECT strftime('%H', created_at) AS hour, COUNT(*) AS orders
       FROM orders
      WHERE created_at >= datetime('now','-7 days')
      GROUP BY hour ORDER BY hour`,
  );

  const ratings = get(
    `SELECT COUNT(*) AS n, COALESCE(AVG(stars),0) AS avg FROM ratings`,
  );

  const customers = get(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`).n;
  const riders = get('SELECT COUNT(*) AS n FROM drivers').n;
  const ridersOnline = get(`SELECT COUNT(*) AS n FROM drivers WHERE status != 'offline'`).n;

  const cancelledToday = get(
    `SELECT COUNT(*) AS n FROM orders
      WHERE date(created_at) = date('now') AND status IN ('cancelled','rejected')`,
  ).n;

  return {
    today: {
      orders: today.orders,
      revenue: today.revenue,
      avgTicket: Math.round(today.avg_ticket),
      cancelled: cancelledToday,
    },
    live: {
      pending: live.pending ?? 0,
      inKitchen: live.in_kitchen ?? 0,
      ready: live.ready ?? 0,
      onTheRoad: live.on_the_road ?? 0,
      active: live.active ?? 0,
    },
    allTime,
    byFulfilment,
    topItems,
    last14,
    hourly,
    ratings: { count: ratings.n, average: Math.round(ratings.avg * 10) / 10 },
    team: { customers, riders, ridersOnline },
    generatedAt: new Date().toISOString(),
  };
}

export function rateOrder({ orderId, user, stars, comment = '' }) {
  const order = getOrderById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.user_id !== user.id && user.role !== 'admin') {
    throw ApiError.forbidden('You can only rate your own orders');
  }
  if (!['completed', 'delivered'].includes(order.status)) {
    throw ApiError.conflict('You can rate an order once it is finished');
  }
  const existing = get('SELECT id FROM ratings WHERE order_id = ?', [orderId]);
  if (existing) throw ApiError.conflict('You have already rated this order');

  run('INSERT INTO ratings (order_id, user_id, stars, comment) VALUES (?, ?, ?, ?)', [
    orderId,
    order.user_id,
    stars,
    String(comment).slice(0, 400),
  ]);

  if (order.driver_id) {
    const agg = get(
      `SELECT AVG(r.stars) AS avg
         FROM ratings r JOIN orders o ON o.id = r.order_id
        WHERE o.driver_id = ?`,
      [order.driver_id],
    );
    if (agg?.avg) run('UPDATE drivers SET rating = ? WHERE id = ?', [Math.round(agg.avg * 10) / 10, order.driver_id]);
  }

  hub.publish(['admin'], 'order.rated', { orderId, stars, driverId: order.driver_id });
  return { ok: true, stars };
}

function minutesSince(sqliteDate) {
  if (!sqliteDate) return 0;
  const then = new Date(`${String(sqliteDate).replace(' ', 'T')}Z`).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.round((Date.now() - then) / 60000));
}

function safeParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const activeStatuses = () => [
  'pending', 'confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way',
];

export default {
  createOrder, transition, hydrate, getOrderById, getOrderByCode, assertCanView,
  listForUser, kitchenQueue, activeDeliveries, listAll, dashboardStats, rateOrder,
  TRANSITIONS, canTransition,
};
