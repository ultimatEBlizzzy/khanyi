import { db, all, get, run } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { haversineKm } from '../lib/geo.js';
import { hub } from './events.js';
import { transition, getOrderById, hydrate } from './orders.js';

/**
 * Dispatch: who is on a bike, who is free, and how a hot order finds a rider.
 *
 * The admin console drives this manually (assign / reassign), but the rules
 * live here so the same guard rails apply when auto-dispatch picks a rider.
 */

const ACTIVE_ORDER_STATUSES = ['assigned', 'picked_up', 'on_the_way'];

export function listRiders({ includeOffline = true } = {}) {
  const rows = all(
    `SELECT d.*, u.name, u.email, u.phone, u.is_active,
            (SELECT COUNT(*) FROM orders o
              WHERE o.driver_id = d.id
                AND o.status IN ('assigned','picked_up','on_the_way')) AS active_orders,
            (SELECT COUNT(*) FROM orders o
              WHERE o.driver_id = d.id AND o.status IN ('delivered','completed')
                AND date(o.created_at) = date('now')) AS delivered_today
       FROM drivers d JOIN users u ON u.id = d.user_id
      ${includeOffline ? '' : "WHERE d.status != 'offline'"}
      ORDER BY d.status = 'offline', active_orders ASC, u.name ASC`,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    vehicle: row.vehicle,
    plate: row.plate,
    status: row.status,
    zone: row.zone,
    rating: row.rating,
    deliveries: row.deliveries,
    activeOrders: row.active_orders,
    deliveredToday: row.delivered_today,
    isActive: Boolean(row.is_active),
    capacity: capacityFor(row.vehicle),
    busy: row.active_orders >= capacityFor(row.vehicle),
    canTakeOrders: Boolean(
      row.is_active && row.status !== 'offline' && row.active_orders < capacityFor(row.vehicle),
    ),
  }));
}

/** A scooter can carry two runs at once; a car can juggle three. */
function capacityFor(vehicle) {
  return vehicle === 'car' ? 3 : vehicle === 'bike' ? 1 : 2;
}

/**
 * Is delivery on the table right now? The storefront asks this before it
 * offers the delivery option, so nobody orders a ride that cannot happen.
 */
export function deliveryAvailability() {
  const riders = listRiders();
  const onShift = riders.filter((r) => r.status !== 'offline' && r.isActive);
  const free = onShift.filter((r) => r.canTakeOrders);

  const fleetNeeded = get(
    `SELECT COUNT(*) AS n FROM orders
      WHERE fulfilment = 'delivery'
        AND status IN ('ready','assigned','picked_up','on_the_way')`,
  ).n;

  return {
    available: free.length > 0,
    ridersOnShift: onShift.length,
    ridersFree: free.length,
    ridersBusy: onShift.length - free.length,
    ridersOffline: riders.length - onShift.length,
    activeDeliveries: fleetNeeded,
    bikeFriendly: onShift.some((r) => r.vehicle === 'bike'),
    reason: free.length > 0
      ? ''
      : onShift.length > 0
        ? 'All our riders are out on deliveries right now — collection is available, or try delivery again in a few minutes.'
        : 'No riders are on shift at the moment. Choose collection, or phone the store to arrange a drop-off.',
    message: free.length > 0
      ? `${free.length} rider${free.length === 1 ? '' : 's'} available in Malamulele`
      : 'Delivery is paused — riders are offline',
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Choose the best rider for an order: free first, then closest to the store,
 * then the one with the lightest load.
 */
export function pickBestRider(order, riders = listRiders()) {
  const candidates = riders.filter((r) => r.canTakeOrders);
  if (candidates.length === 0) return null;

  const store = { lat: -22.9573, lng: 30.7273 };
  const scored = candidates.map((rider) => ({
    rider,
    score:
      rider.activeOrders * 10 +
      (rider.status === 'busy' ? 3 : 0) +
      (rider.vehicle === 'scooter' ? 0 : rider.vehicle === 'bike' ? 0.5 : 1) +
      (order?.distance_km ?? 0) * 0.1 +
      haversineKm(store, store) * 0,
  }));
  scored.sort((a, b) => a.score - b.score || b.rider.rating - a.rider.rating);
  return scored[0].rider;
}

export function assignRider(orderId, { driverId, actor, force = false }) {
  const order = getOrderById(orderId);
  if (!order) throw ApiError.notFound('Order not found');
  if (order.fulfilment !== 'delivery') {
    throw ApiError.unprocessable('That is a collection order — no rider needed');
  }
  if (['delivered', 'completed', 'cancelled', 'rejected'].includes(order.status)) {
    throw ApiError.conflict('That order is already finished');
  }

  const rider = get('SELECT * FROM drivers WHERE id = ?', [driverId]);
  if (!rider) throw ApiError.notFound('No such rider');

  if (order.status === 'assigned') {
    // Reassignment: the old rider is freed, the new one takes over.
    return reassign(order, rider, actor, force);
  }

  // The driver_id write happens inside transition()'s transaction, so a
  // failed permission check can never leave the order half-assigned.
  const updated = transition(order.id, 'assigned', {
    actor,
    driverId: rider.id,
    note: `Assigned to ${riderName(rider.id)}`,
  });
  refreshDriverStatus(rider.id);
  return updated;
}

function reassign(order, rider, actor, force) {
  const previous = order.driver_id;
  if (previous === rider.id && !force) {
    throw ApiError.conflict('That rider already has this order');
  }

  db.transaction(() => {
    run('UPDATE orders SET driver_id = ? WHERE id = ?', [rider.id, order.id]);
    run(
      `INSERT INTO order_events (order_id, from_state, to_state, actor_name, actor_role, note)
       VALUES (?, 'assigned', 'assigned', ?, ?, ?)`,
      [order.id, actor?.name ?? 'system', actor?.role ?? 'system', `Reassigned to ${riderName(rider.id)}`],
    );
    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, ?, 'dispatch.reassign', 'order', ?, ?)`,
      [actor?.id ?? null, actor?.name ?? 'system', String(order.id), JSON.stringify({ from: previous, to: rider.id })],
    );
  })();

  if (previous) refreshDriverStatus(previous);
  refreshDriverStatus(rider.id);

  const fresh = hydrate(getOrderById(order.id));
  hub.publish(['orders', 'staff', 'admin', 'drivers'], 'order.reassigned', {
    orderId: order.id,
    code: order.code,
    fromDriverId: previous,
    toDriverId: rider.id,
    toDriverName: riderName(rider.id),
  });
  hub.publish([`user:${get('SELECT user_id FROM drivers WHERE id = ?', [rider.id]).user_id}`], 'order.assigned', {
    orderId: order.id,
    code: order.code,
    addressLine: order.address_line,
    suburb: order.address_suburb,
    total: order.total,
  });
  return fresh;
}

/** A rider claiming a ready order themselves from the rider board. */
export function claimOrder(orderId, user) {
  const driver = get('SELECT * FROM drivers WHERE user_id = ?', [user.id]);
  if (!driver) throw ApiError.forbidden('No rider profile linked to this account');
  if (driver.status === 'offline') {
    throw ApiError.conflict('Go online before claiming a run');
  }
  return assignRider(orderId, { driverId: driver.id, actor: { ...user, role: 'admin' } });
}

/** Auto-dispatch: called when an order becomes ready, if the store allows it. */
export function autoAssign(orderId, actor = { id: null, name: 'auto-dispatch', role: 'system' }) {
  const order = getOrderById(orderId);
  if (!order || order.fulfilment !== 'delivery' || order.status !== 'ready') return null;

  const rider = pickBestRider(order);
  if (!rider) {
    hub.publish(['admin', 'staff'], 'dispatch.no_rider', {
      orderId: order.id,
      code: order.code,
      message: 'Order is ready but every rider is offline',
    });
    return null;
  }
  return assignRider(order.id, { driverId: rider.id, actor });
}

export function setDriverStatus(user, status) {
  const driver = get('SELECT * FROM drivers WHERE user_id = ?', [user.id]);
  if (!driver) throw ApiError.forbidden('No rider profile linked to this account');

  const active = get(
    `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status IN ('assigned','picked_up','on_the_way')`,
    [driver.id],
  ).n;

  if (status === 'offline' && active > 0) {
    throw ApiError.conflict(`Finish your ${active} open run${active === 1 ? '' : 's'} before going offline`);
  }

  run('UPDATE drivers SET status = ? WHERE id = ?', [status, driver.id]);
  const fresh = listRiders().find((r) => r.id === driver.id);

  hub.publish(['admin', 'drivers'], 'driver.status', {
    driverId: driver.id,
    name: user.name,
    status,
    available: deliveryAvailability(),
  });
  return fresh;
}

/** Keep the rider's avatar honest after every state change. */
export function refreshDriverStatus(driverId) {
  const driver = get('SELECT * FROM drivers WHERE id = ?', [driverId]);
  if (!driver) return null;

  const active = get(
    `SELECT COUNT(*) AS n FROM orders WHERE driver_id = ? AND status IN ('assigned','picked_up','on_the_way')`,
    [driverId],
  ).n;

  const next = active > 0 ? 'busy' : driver.status === 'offline' ? 'offline' : 'online';
  if (next !== driver.status) {
    run('UPDATE drivers SET status = ? WHERE id = ?', [next, driverId]);
    hub.publish(['admin', 'drivers'], 'driver.status', { driverId, status: next });
  }
  return next;
}

export function riderBoard(user) {
  const driver = get('SELECT * FROM drivers WHERE user_id = ?', [user.id]);
  if (!driver) throw ApiError.forbidden('No rider profile linked to this account');

  const mine = all(
    `SELECT o.*, u.name AS customer_name_full, u.phone AS customer_phone_full
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.driver_id = ? AND o.status IN ('assigned','picked_up','on_the_way')
      ORDER BY CASE o.status WHEN 'picked_up' THEN 0 WHEN 'on_the_way' THEN 1 ELSE 2 END, o.id`,
    [driver.id],
  ).map((order) => ({
    ...order,
    items: all('SELECT name, qty, options_json, notes FROM order_items WHERE order_id = ?', [order.id]).map((i) => ({
      ...i,
      options: safeJson(i.options_json, []),
    })),
  }));

  const myToday = get(
    `SELECT COUNT(*) AS deliveries, COALESCE(SUM(delivery_fee),0) AS fees, COALESCE(SUM(total),0) AS value
       FROM orders
      WHERE driver_id = ? AND status IN ('delivered','completed') AND date(completed_at) = date('now')`,
    [driver.id],
  );

  const openPool = all(
    `SELECT o.id, o.code, o.total, o.delivery_fee, o.address_line, o.address_suburb,
            o.distance_km, o.customer_name, o.eta_minutes, o.created_at
       FROM orders o
      WHERE o.fulfilment = 'delivery' AND o.status = 'ready' AND o.driver_id IS NULL
      ORDER BY o.id ASC
      LIMIT 20`,
  );

  const recent = all(
    `SELECT id, code, address_line, address_suburb, total, delivery_fee, completed_at, status
       FROM orders
      WHERE driver_id = ? AND status IN ('delivered','completed')
      ORDER BY id DESC LIMIT 10`,
    [driver.id],
  );

  return {
    driver: {
      id: driver.id,
      name: user.name,
      phone: user.phone,
      vehicle: driver.vehicle,
      plate: driver.plate,
      status: driver.status,
      zone: driver.zone,
      rating: driver.rating,
      deliveries: driver.deliveries,
      capacity: capacityFor(driver.vehicle),
    },
    active: mine,
    pool: openPool,
    today: myToday,
    recent,
    availability: deliveryAvailability(),
    serverTime: new Date().toISOString(),
  };
}

function riderName(driverId) {
  return get('SELECT u.name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = ?', [driverId])?.name ?? 'rider';
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function driverById(id) {
  return get('SELECT * FROM drivers WHERE id = ?', [id]);
}

export function createRiderProfile(userId, { vehicle = 'scooter', plate = '', zone = 'Malamulele' } = {}) {
  const existing = get('SELECT * FROM drivers WHERE user_id = ?', [userId]);
  if (existing) return existing;
  const info = run(
    'INSERT INTO drivers (user_id, vehicle, plate, zone, status) VALUES (?, ?, ?, ?, "online")',
    [userId, vehicle, plate, zone],
  );
  return get('SELECT * FROM drivers WHERE id = ?', [info.lastInsertRowid]);
}

/* ------------------------------------------------------------------ *
 * Auto-dispatch: when the kitchen marks a delivery order ready and the
 * store has auto-assign switched on, send the nearest free rider.
 * ------------------------------------------------------------------ */
hub.on('event', (event) => {
  if (event.type !== 'order.updated' || event.payload?.status !== 'ready') return;
  const order = getOrderById(event.payload.orderId);
  if (!order || order.fulfilment !== 'delivery') return;

  const auto = get(`SELECT value FROM settings WHERE key = 'auto_assign_riders'`);
  if (!auto || auto.value !== '1') return;
  try {
    autoAssign(order.id);
  } catch (error) {
    console.warn('[dispatch] auto-assign failed:', error.message);
  }
});

export default {
  listRiders, deliveryAvailability, pickBestRider, assignRider, claimOrder,
  autoAssign, setDriverStatus, riderBoard, createRiderProfile, refreshDriverStatus, driverById,
};
