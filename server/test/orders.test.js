import assert from 'node:assert/strict';
import test from 'node:test';

import './helpers.js';
import { get, run, all } from '../src/db/index.js';
import { getItemDetail } from '../src/services/menu.js';
import {
  createOrder, transition, getOrderById, hydrate, canTransition, rateOrder,
} from '../src/services/orders.js';

function cart(slug, qty = 1, extra = []) {
  const item = getItemDetail(slug);
  const required = item.optionGroups.filter((g) => g.required).map((g) => g.options[0].id);
  return { itemId: item.id, qty, optionIds: [...required, ...extra] };
}

const me = () => get('SELECT * FROM users WHERE email = ?', ['customer@demo.kk']);
const admin = () => get('SELECT * FROM users WHERE email = ?', ['admin@demo.kk']);
const rider = (email = 'driver@demo.kk') => {
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  const profile = get('SELECT * FROM drivers WHERE user_id = ?', [user.id]);
  return { ...user, driverId: profile.id };
};

const place = (payload, user = me()) =>
  createOrder({ user, payload, idempotencyKey: `test-${Math.random().toString(36).slice(2)}` });

/* ------------------------------ happy paths ------------------------------ */

test('a collection order walks the whole line and pays out loyalty on completion', () => {
  const user = me();
  const before = get('SELECT loyalty_points FROM users WHERE id = ?', [user.id]).loyalty_points;

  const { order } = place({
    items: [cart('toasted-sandwich', 2)],
    fulfilment: 'collection',
    customerPhone: '073 811 2207',
  });

  assert.match(order.code, /^KK-[A-Z0-9]{6}$/);
  assert.equal(order.status, 'pending');
  assert.equal(order.fulfilment, 'collection');
  assert.equal(order.delivery_fee, 0);
  assert.equal(order.items.length, 1);
  assert.equal(order.events.length, 1);

  assert.equal(transition(order.id, 'confirmed', { actor: admin() }).status, 'confirmed');
  assert.equal(transition(order.id, 'preparing', { actor: admin() }).status, 'preparing');
  const ready = transition(order.id, 'ready', { actor: admin() });
  assert.equal(ready.status, 'ready');
  assert.ok(ready.ready_at, 'the ready timestamp is stamped');

  const done = transition(order.id, 'completed', { actor: admin(), note: 'Collected' });
  assert.equal(done.status, 'completed');

  const after = get('SELECT loyalty_points FROM users WHERE id = ?', [user.id]).loyalty_points;
  assert.equal(after, before + done.points_earned, 'points land when the order completes');
  assert.ok(done.points_earned > 0);
  assert.equal(done.events.length, 5, 'every hop is journalled');
  assert.ok(done.events.every((event) => event.created_at), 'events are timestamped');
});

test('a delivery order is auto-assigned when it leaves the kitchen, then rides out', () => {
  const { order } = place({
    items: [cart('dunked-wings', 2)],
    fulfilment: 'delivery',
    address: { line1: '1123 Malamulele Main Road', suburb: 'Malamulele B', lat: -22.9611, lng: 30.7195 },
  });

  assert.ok(order.delivery_fee >= 0);
  assert.ok(order.distance_km > 0, 'the ride distance is measured from the store');

  transition(order.id, 'confirmed', { actor: admin() });
  transition(order.id, 'preparing', { actor: admin() });
  transition(order.id, 'ready', { actor: admin() });

  // Auto-dispatch (setting auto_assign_riders = 1) puts the nearest free
  // rider on the order the moment the kitchen marks it ready.
  const assigned = getOrderById(order.id);
  assert.equal(assigned.status, 'assigned');
  assert.ok(assigned.driver_id, 'a rider was assigned automatically');

  const myRider = rider('driver@demo.kk');
  const otherRider = rider('thabo.rider@demo.kk');
  const actor = assigned.driver_id === myRider.driverId ? myRider : otherRider;
  const intruder = actor === myRider ? otherRider : myRider;

  assert.throws(
    () => transition(order.id, 'picked_up', { actor: intruder }),
    /not assigned to you/,
    'a rider cannot move somebody else\'s delivery',
  );

  transition(order.id, 'picked_up', { actor });
  transition(order.id, 'on_the_way', { actor });
  const delivered = transition(order.id, 'delivered', { actor });
  assert.equal(delivered.status, 'delivered');
  assert.ok(delivered.dispatched_at && delivered.completed_at);
});

test('a delivery cannot skip the rider entirely', () => {
  const { order } = place({
    items: [cart('chips', 1)],
    fulfilment: 'delivery',
    address: { line1: '88 Giyani Road', lat: -22.9481, lng: 30.7412 },
  });
  transition(order.id, 'confirmed', { actor: admin() });
  transition(order.id, 'preparing', { actor: admin() });
  transition(order.id, 'ready', { actor: admin() });

  // Force the order back to "ready" with no rider, as if the rider released it.
  run('UPDATE orders SET driver_id = NULL, status = \'ready\' WHERE id = ?', [order.id]);
  assert.throws(
    () => transition(order.id, 'picked_up', { actor: rider() }),
    /not assigned to you/,
  );
  assert.throws(
    () => transition(order.id, 'completed', { actor: admin() }),
    /closes out once the rider|completed once the rider/,
  );
  const assigned = transition(order.id, 'assigned', { actor: admin(), driverId: rider().driverId });
  assert.equal(assigned.status, 'assigned');
  assert.equal(assigned.driver.name, 'Sipho Ndlovu');
});

/* ------------------------------ guard rails ------------------------------ */

test('the state machine refuses illegal jumps', () => {
  assert.equal(canTransition('pending', 'delivered'), false);
  assert.equal(canTransition('cancelled', 'confirmed'), false);
  assert.equal(canTransition('completed', 'cancelled'), false);
  assert.equal(canTransition('ready', 'assigned'), true);

  const { order } = place({ items: [cart('chips', 2)], fulfilment: 'collection' });
  assert.throws(() => transition(order.id, 'delivered', { actor: admin() }), /cannot become|only applies/);
});

test('actors are held to their own powers', () => {
  const { order } = place({ items: [cart('chips', 1)], fulfilment: 'collection' });

  assert.throws(() => transition(order.id, 'confirmed', { actor: me() }), /cannot mark an order as|cannot change/);
  assert.throws(() => transition(order.id, 'confirmed', { actor: rider() }), /not assigned to you|A driver cannot/);

  // A different customer cannot touch someone else's order.
  const other = get('SELECT * FROM users WHERE email = ?', ['tinyiko@demo.kk']);
  assert.throws(() => transition(order.id, 'cancelled', { actor: other }), /belongs to somebody else/);
});

test('a collection order can never be assigned to a rider', () => {
  const { order } = place({ items: [cart('chips', 1)], fulfilment: 'collection' });
  assert.throws(
    () => transition(order.id, 'assigned', { actor: admin(), driverId: rider().driverId }),
    /do not get a rider/,
  );
});

test('delivery without an address is rejected before anything is written', () => {
  assert.throws(
    () => place({ items: [cart('chips', 1)], fulfilment: 'delivery' }),
    /delivery address/,
  );
});

test('a sold-out item cannot be ordered', () => {
  const item = getItemDetail('cake-slice');
  run('UPDATE menu_items SET track_stock = 1, stock = 0 WHERE id = ?', [item.id]);
  try {
    assert.throws(
      () => place({ items: [{ itemId: item.id, qty: 1 }], fulfilment: 'collection' }),
      /sold out/i,
    );
  } finally {
    run('UPDATE menu_items SET stock = 18 WHERE id = ?', [item.id]);
  }
});

/* ------------------------------ reliability ------------------------------ */

test('the same idempotency key never creates a second order', () => {
  const key = 'idem-replay-001';
  const first = createOrder({ user: me(), payload: { items: [cart('chips', 1)], fulfilment: 'collection' }, idempotencyKey: key });
  const second = createOrder({ user: me(), payload: { items: [cart('chips', 1)], fulfilment: 'collection' }, idempotencyKey: key });

  assert.equal(second.replayed, true);
  assert.equal(second.order.id, first.order.id);
  assert.equal(
    get('SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?', [key]).n,
    1,
    'only one row exists',
  );
});

test('stock is reserved on order and returned on cancellation', () => {
  const item = getItemDetail('cupcake-box');
  run('UPDATE menu_items SET track_stock = 1, stock = 10 WHERE id = ?', [item.id]);

  const before = get('SELECT stock FROM menu_items WHERE id = ?', [item.id]).stock;
  const { order } = place({ items: [cart('cupcake-box', 3)], fulfilment: 'collection' });
  const reserved = get('SELECT stock FROM menu_items WHERE id = ?', [item.id]).stock;
  assert.equal(reserved, before - 3);

  transition(order.id, 'cancelled', { actor: admin(), reason: 'test' });
  const restored = get('SELECT stock FROM menu_items WHERE id = ?', [item.id]).stock;
  assert.equal(restored, before, 'cancelling puts the cupcakes back on the shelf');
});

test('redeemed points leave immediately, cancelled orders do not mint points', () => {
  const user = me();
  run('UPDATE users SET loyalty_points = 500 WHERE id = ?', [user.id]);

  const { order } = place({
    items: [cart('toasted-sandwich', 3)],
    fulfilment: 'collection',
    redeemPoints: 200,
  });

  assert.equal(order.points_redeemed, 200);
  assert.equal(order.discount, 2000);
  assert.equal(get('SELECT loyalty_points FROM users WHERE id = ?', [user.id]).loyalty_points, 300);

  transition(order.id, 'cancelled', { actor: admin(), reason: 'changed mind' });
  assert.equal(
    get('SELECT loyalty_points FROM users WHERE id = ?', [user.id]).loyalty_points,
    300,
    'no points are earned for a cancelled order',
  );
});

test('every order total equals its lines plus delivery minus discounts', () => {
  const { order } = place({
    items: [cart('dunked-wings', 2), cart('cold-drink-330ml', 2), cart('chips', 1)],
    fulfilment: 'delivery',
    address: { line1: '88 Giyani Road', lat: -22.9481, lng: 30.7412 },
    promoCode: 'WINGS10',
  });

  const lines = all('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
  const sum = lines.reduce((total, line) => total + line.line_total, 0);
  assert.equal(order.subtotal, sum);
  assert.equal(order.total, order.subtotal - order.discount + order.delivery_fee);
  assert.ok(order.total > 0);
});

test('an order can only be rated once, and only when it is finished', () => {
  const user = me();
  const { order } = place({ items: [cart('chips', 1)], fulfilment: 'collection' });

  assert.throws(() => rateOrder({ orderId: order.id, user, stars: 5 }), /once it is finished/);

  transition(order.id, 'confirmed', { actor: admin() });
  transition(order.id, 'preparing', { actor: admin() });
  transition(order.id, 'ready', { actor: admin() });
  transition(order.id, 'completed', { actor: admin() });

  assert.deepEqual(rateOrder({ orderId: order.id, user, stars: 5, comment: 'Great' }), { ok: true, stars: 5 });
  assert.throws(() => rateOrder({ orderId: order.id, user, stars: 4 }), /already rated/);
});

test('order codes stay unique under a burst of orders', () => {
  const user = me();
  const codes = new Set();
  for (let i = 0; i < 25; i += 1) {
    const { order } = createOrder({
      user,
      payload: { items: [cart('chips', 1)], fulfilment: 'collection' },
      idempotencyKey: `burst-${i}`,
    });
    codes.add(order.code);
  }
  assert.equal(codes.size, 25);
});

test('hydrated orders expose the timeline the storefront renders', () => {
  const { order } = place({ items: [cart('chips', 1)], fulfilment: 'collection' });
  const model = hydrate(getOrderById(order.id));
  assert.equal(model.timeline.steps[0], 'pending');
  assert.equal(model.timeline.cancelled, false);
  assert.equal(model.statusLabel, 'Order placed');
});
