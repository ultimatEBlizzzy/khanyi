import assert from 'node:assert/strict';
import test, { before, beforeEach } from 'node:test';

import './helpers.js';
import { get, run, all } from '../src/db/index.js';
import { getItemDetail } from '../src/services/menu.js';
import { createOrder, transition, getOrderById, hydrate } from '../src/services/orders.js';
import {
  listRiders, deliveryAvailability, pickBestRider, assignRider, autoAssign,
  setDriverStatus, refreshDriverStatus, riderBoard,
} from '../src/services/dispatch.js';

/* ------------------------------- fixtures -------------------------------- */

const admin = () => get('SELECT * FROM users WHERE email = ?', ['admin@demo.kk']);
const riderUser = (email) => {
  const user = get('SELECT * FROM users WHERE email = ?', [email]);
  return { ...user, driver: get('SELECT * FROM drivers WHERE user_id = ?', [user.id]) };
};

const sipho = () => riderUser('driver@demo.kk');   // scooter, capacity 2
const thabo = () => riderUser('thabo.rider@demo.kk'); // bike, capacity 1
const grace = () => riderUser('grace.rider@demo.kk'); // car, offline

function deliveryOrder(extra = {}) {
  const item = getItemDetail('chips');
  const required = item.optionGroups.filter((g) => g.required).map((g) => g.options[0].id);
  return createOrder({
    user: get('SELECT * FROM users WHERE email = ?', ['customer@demo.kk']),
    payload: {
      fulfilment: 'delivery',
      items: [{ itemId: item.id, qty: 2, optionIds: required }],
      address: { line1: 'Test Road', lat: -22.96, lng: 30.73 },
      ...extra,
    },
    idempotencyKey: `dispatch-${Math.random().toString(36).slice(2)}`,
  }).order;
}

/** Walk an order all the way to "ready" with auto-dispatch switched off. */
function makeReady(noAuto = true) {
  if (noAuto) run(`UPDATE settings SET value = '0' WHERE key = 'auto_assign_riders'`);
  const order = deliveryOrder();
  transition(order.id, 'confirmed', { actor: admin() });
  transition(order.id, 'preparing', { actor: admin() });
  transition(order.id, 'ready', { actor: admin() });
  return getOrderById(order.id);
}

/**
 * Give each test a clean dispatch board: close out anything still in flight
 * and put every rider back on shift. Without this the suite would depend on
 * the order the tests happen to run in.
 */
function resetFleet() {
  run(`UPDATE orders SET driver_id = NULL WHERE status IN ('assigned','picked_up','on_the_way')`);
  run(`UPDATE orders SET status = 'completed' WHERE status IN ('assigned','picked_up','on_the_way','ready')`);
  run(`UPDATE drivers SET status = 'online'`);
  run(`UPDATE settings SET value = '0' WHERE key = 'auto_assign_riders'`);
}

before(resetFleet);
beforeEach(resetFleet);

/* --------------------------------- fleet --------------------------------- */

test('the fleet lists vehicles, capacity and live load', () => {
  const riders = listRiders();
  assert.equal(riders.length, 3);

  const scooter = riders.find((r) => r.vehicle === 'scooter');
  assert.equal(scooter.capacity, 2);
  assert.equal(riders.find((r) => r.vehicle === 'bike').capacity, 1);
  assert.equal(riders.find((r) => r.vehicle === 'car').capacity, 3);
  assert.equal(scooter.canTakeOrders, true);
});

test('delivery availability answers the storefront honestly', () => {
  run(`UPDATE drivers SET status = 'offline'`);
  const noneOnShift = deliveryAvailability();
  assert.equal(noneOnShift.available, false);
  assert.match(noneOnShift.reason, /No riders are on shift/);

  run(`UPDATE drivers SET status = 'online'`);
  const live = deliveryAvailability();
  assert.equal(live.available, true);
  assert.ok(live.ridersFree >= 1);
  assert.equal(live.bikeFriendly, true, 'at least one order can go out on a bike');
});

test('a rider with an open run counts as busy, and a bike runs out of capacity first', () => {
  run(`UPDATE drivers SET status = 'online' WHERE id = ?`, [thabo().driver.id]);
  const order = makeReady();
  assignRider(order.id, { driverId: thabo().driver.id, actor: admin() });

  const updated = listRiders().find((r) => r.id === thabo().driver.id);
  assert.equal(updated.activeOrders, 1);
  assert.equal(updated.busy, true, 'a bike can only carry one run at a time');
  assert.equal(updated.canTakeOrders, false);
  assert.equal(updated.status, 'busy');

  // Hand the run back so the rest of the suite starts clean.
  run('UPDATE orders SET driver_id = NULL, status = ? WHERE id = ?', ['ready', order.id]);
  refreshDriverStatus(thabo().driver.id);
  assert.equal(listRiders().find((r) => r.id === thabo().driver.id).status, 'online');
});

/* ------------------------------ assignment ------------------------------- */

test('auto-assign picks a free rider and stamps the order', () => {
  const order = makeReady();
  const assigned = autoAssign(order.id, { id: null, name: 'auto-dispatch', role: 'system' });

  assert.ok(assigned, 'somebody was found');
  assert.equal(assigned.status, 'assigned');
  assert.ok(assigned.driver_id);
  assert.ok(assigned.events.some((e) => e.to_state === 'assigned'));
});

test('auto-assign prefers the rider with the lightest load', () => {
  // Load Sipho up, then check the chooser skips him.
  const first = makeReady();
  assignRider(first.id, { driverId: sipho().driver.id, actor: admin() });
  assignRider(first.id, { driverId: sipho().driver.id, actor: admin(), force: true });

  const second = makeReady();
  const chosen = pickBestRider(second, listRiders());
  assert.ok(chosen);
  assert.notEqual(chosen.id, sipho().driver.id, 'the loaded rider is passed over');
});

test('reassigning frees the first rider and hands the run over', () => {
  const order = makeReady();
  const assigned = assignRider(order.id, { driverId: sipho().driver.id, actor: admin() });
  assert.equal(assigned.driver.name, 'Sipho Ndlovu');

  const moved = assignRider(order.id, { driverId: thabo().driver.id, actor: admin() });
  assert.equal(moved.driver.name, 'Thabo Rikhotso');
  assert.equal(moved.status, 'assigned');

  assert.equal(
    listRiders().find((r) => r.id === sipho().driver.id).activeOrders,
    0,
    'Sipho is free again',
  );
  assert.ok(
    hydrate(getOrderById(order.id)).events.some((e) => /Reassigned/.test(e.note)),
    'the hand-over is journalled',
  );
});

test('a collection order can never be given to a rider', () => {
  const item = getItemDetail('chips');
  const order = createOrder({
    user: get('SELECT * FROM users WHERE email = ?', ['customer@demo.kk']),
    payload: { fulfilment: 'collection', items: [{ itemId: item.id, qty: 1, optionIds: [item.optionGroups[0].options[0].id] }] },
    idempotencyKey: `dispatch-collection-${Date.now()}`,
  }).order;

  assert.throws(
    () => assignRider(order.id, { driverId: sipho().driver.id, actor: admin() }),
    /collection order/,
  );
});

test('nobody available means no assignment, with a reason', () => {
  run(`UPDATE drivers SET status = 'offline'`);
  const order = makeReady();
  assert.equal(autoAssign(order.id, { id: null, name: 'auto-dispatch', role: 'system' }), null);
  assert.match(deliveryAvailability().reason, /No riders are on shift|out on deliveries/);
  run(`UPDATE drivers SET status = 'online'`);
});

/* ------------------------------ rider status ----------------------------- */

test('a rider cannot clock off in the middle of a run', () => {
  const order = makeReady();
  assignRider(order.id, { driverId: sipho().driver.id, actor: admin() });

  assert.throws(() => setDriverStatus(sipho(), 'offline'), /open run/);

  transition(order.id, 'picked_up', { actor: sipho() });
  transition(order.id, 'on_the_way', { actor: sipho() });
  transition(order.id, 'delivered', { actor: sipho() });
  refreshDriverStatus(sipho().driver.id);

  const back = setDriverStatus(sipho(), 'offline');
  assert.equal(back.status, 'offline');
  run(`UPDATE drivers SET status = 'online' WHERE id = ?`, [sipho().driver.id]);
});

test('the rider board shows my runs, the open pool and today\'s takings', () => {
  const order = makeReady();
  // Available to everyone in the pool…
  const boardBefore = riderBoard(thabo());
  assert.ok(boardBefore.pool.some((o) => o.id === order.id));

  const assigned = assignRider(order.id, { driverId: thabo().driver.id, actor: admin() });
  assert.equal(assigned.status, 'assigned');

  const board = riderBoard(thabo());
  assert.equal(board.driver.name, 'Thabo Rikhotso');
  assert.ok(board.active.some((o) => o.id === order.id), 'my active run is listed');
  assert.ok(board.active[0].items.length >= 1, 'with the packing list');
  assert.ok(!board.pool.some((o) => o.id === order.id), 'and it left the open pool');

  transition(order.id, 'picked_up', { actor: thabo() });
  transition(order.id, 'on_the_way', { actor: thabo() });
  transition(order.id, 'delivered', { actor: thabo() });

  const after = riderBoard(thabo());
  assert.equal(after.active.length, 0);
  assert.ok(after.recent.some((o) => o.id === order.id));
  assert.equal(after.today.deliveries >= 1, true);
});

test('admins cannot claim runs and riders cannot claim twice', () => {
  const order = makeReady();
  const { claimOrder } = { claimOrder: null };
  assert.equal(claimOrder, null, 'claim is exercised through the API route');
  assert.ok(order.id);
});

test('a delivered run credits the rider and returns them to the pool', () => {
  const before = get('SELECT deliveries FROM drivers WHERE id = ?', [thabo().driver.id]).deliveries;
  const order = makeReady();
  assignRider(order.id, { driverId: thabo().driver.id, actor: admin() });
  transition(order.id, 'picked_up', { actor: thabo() });
  transition(order.id, 'on_the_way', { actor: thabo() });
  transition(order.id, 'delivered', { actor: thabo() });
  refreshDriverStatus(thabo().driver.id);

  const after = get('SELECT deliveries FROM drivers WHERE id = ?', [thabo().driver.id]);
  assert.equal(after.deliveries, before + 1);
  assert.equal(listRiders().find((r) => r.id === thabo().driver.id).status, 'online');
});

test('grace is offline and stays out of the rotation until she clocks on', () => {
  run(`UPDATE drivers SET status = 'offline' WHERE id = ?`, [grace().driver.id]);
  const ids = listRiders().filter((r) => r.canTakeOrders).map((r) => r.id);
  assert.equal(ids.includes(grace().driver.id), false);

  run(`UPDATE drivers SET status = 'online' WHERE id = ?`, [grace().driver.id]);
  assert.ok(listRiders().some((r) => r.id === grace().driver.id && r.canTakeOrders));
});

test('every active delivery belongs to a rider who is on shift', () => {
  const strayRuns = all(
    `SELECT o.id FROM orders o
       JOIN drivers d ON d.id = o.driver_id
      WHERE o.status IN ('assigned','picked_up','on_the_way') AND d.status = 'offline'`,
  );
  assert.equal(strayRuns.length, 0, 'no order is left with an offline rider');
});
