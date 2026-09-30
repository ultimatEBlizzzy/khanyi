import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { api, startServer, stopServer, primeTokens, tokens, findItem } from './helpers.js';

let base;

before(async () => {
  base = await startServer();
  await primeTokens();
});

after(async () => {
  await stopServer();
});

/* -------------------------------- health -------------------------------- */

test('health endpoint reports the service state', async () => {
  const { status, body } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.ok(typeof body.liveClients === 'number');
});

/* --------------------------------- auth --------------------------------- */

test('a new customer can register and is signed in immediately', async () => {
  const email = `newbie-${Date.now()}@example.com`;
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'New Customer', email, phone: '072 000 1111', password: 'secret123' },
  });
  assert.equal(status, 201);
  assert.ok(body.token);
  assert.equal(body.user.role, 'customer');

  const me = await api('/api/auth/me', { token: body.token });
  assert.equal(me.body.user.email, email);
  assert.deepEqual(me.body.addresses, []);
});

test('registration validates the input instead of trusting it', async () => {
  const missingPassword = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'No Password', email: 'nopass@example.com' },
  });
  assert.equal(missingPassword.status, 422);

  const badEmail = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Bad Email', email: 'not-an-email', password: 'secret123' },
  });
  assert.equal(badEmail.status, 422);

  const short = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Shorty', email: 'shorty@example.com', password: 'abc' },
  });
  assert.equal(short.status, 422);
});

test('a duplicate email is refused with a friendly message', async () => {
  const { status, body } = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Nomsa Again', email: 'customer@demo.kk', password: 'secret123' },
  });
  assert.equal(status, 409);
  assert.match(body.error.message, /already has an account/);
});

test('a wrong password is a 401 and does not leak whether the email exists', async () => {
  const wrong = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'customer@demo.kk', password: 'nope-nope' },
  });
  const ghost = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'nope-nope' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(ghost.status, 401);
  assert.equal(wrong.body.error.message, ghost.body.error.message);
});

test('repeated failed logins hit the rate limiter', async () => {
  let limited = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { status } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'ratelimit-target@example.com', password: 'wrong-password' },
    });
    if (status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, 'the account limiter eventually says stop');
});

test('protected routes demand a token', async () => {
  assert.equal((await api('/api/auth/me')).status, 401);
  assert.equal((await api('/api/orders')).status, 401);
  const forged = await api('/api/auth/me', { token: 'aaa.bbb' });
  assert.equal(forged.status, 401);
});

/* ------------------------------ storefront ------------------------------ */

test('the storefront bootstrap carries the full poster menu', async () => {
  const { status, body } = await api('/api/store');
  assert.equal(status, 200);
  assert.equal(body.store.name, "Khanyisile's Kitchen");
  assert.equal(body.store.suburb, 'Malamulele');
  assert.equal(body.delivery.radiusKm, 12);
  assert.ok(body.menu.length >= 7);
  assert.ok(body.promos.length >= 3);
  assert.equal(typeof body.delivery.available, 'boolean');
});

test('item lookup works by slug and by id, and 404s for nonsense', async () => {
  const bySlug = await api('/api/menu/items/dunked-wings');
  assert.equal(bySlug.status, 200);
  assert.ok(bySlug.body.item.optionGroups.length >= 2);

  const byId = await api(`/api/menu/items/${bySlug.body.item.id}`);
  assert.equal(byId.body.item.name, 'Dunked Wings');

  assert.equal((await api('/api/menu/items/unicorn-steak')).status, 404);
});

test('quotes explain problems instead of failing silently', async () => {
  const chips = await findItem('chips');
  const portion = chips.optionGroups[0].options[0].id;

  const tooFar = await api('/api/orders/quote', {
    method: 'POST',
    body: {
      fulfilment: 'delivery',
      items: [{ itemId: chips.id, qty: 2, optionIds: [portion] }],
      address: { line1: 'Cape Town', lat: -33.9249, lng: 18.4241 },
    },
  });
  assert.equal(tooFar.status, 200);
  assert.equal(tooFar.body.canCheckout, false);
  assert.ok(tooFar.body.issues.some((i) => i.code === 'out_of_radius'));

  const badItem = await api('/api/orders/quote', {
    method: 'POST',
    body: { items: [{ itemId: 999999, qty: 1 }], fulfilment: 'collection' },
  });
  assert.equal(badItem.status, 422);
});

/* -------------------------------- orders -------------------------------- */

async function placeOrder(token, extra = {}) {
  const wings = await findItem('dunked-wings');
  const portion = wings.optionGroups.find((g) => g.name === 'Portion').options[2].id;
  const sauce = wings.optionGroups.find((g) => g.name === 'Sauce').options[0].id;

  return api('/api/orders', {
    method: 'POST',
    token,
    headers: { 'idempotency-key': `api-${Math.random().toString(36).slice(2)}` },
    body: {
      fulfilment: 'collection',
      items: [{ itemId: wings.id, qty: 2, optionIds: [portion, sauce] }],
      ...extra,
    },
  });
}

test('a signed-in customer can place an order and re-read it', async () => {
  const { status, body } = await placeOrder(tokens.customer);
  assert.equal(status, 201);
  assert.equal(body.order.customer_name, 'Nomsa Mokoena');
  assert.equal(body.order.items[0].options.length, 2);

  const fetched = await api(`/api/orders/${body.order.code}`, { token: tokens.customer });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.order.code, body.order.code);

  const receipt = await api(`/api/orders/${body.order.id}/receipt`, { token: tokens.customer });
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.receipt.code, body.order.code);
  assert.ok(receipt.body.receipt.lines.length >= 1);
});

test('one customer cannot read another customer order', async () => {
  const { body } = await placeOrder(tokens.customer);
  const other = await api('/api/auth/login', {
    method: 'POST',
    body: { email: 'tinyiko@demo.kk', password: 'demo1234' },
  });
  const peek = await api(`/api/orders/${body.order.id}`, { token: other.body.token });
  assert.equal(peek.status, 403);
});

test('order history lists only my own orders', async () => {
  const { body } = await api('/api/orders?limit=50', { token: tokens.customer });
  assert.ok(body.orders.length > 0);
  assert.ok(body.orders.every((order) => order.customer_email === 'customer@demo.kk'));
});

test('an unsigned-in visitor cannot place an order', async () => {
  const { status } = await api('/api/orders', {
    method: 'POST',
    body: { fulfilment: 'collection', items: [{ itemId: 1, qty: 1 }] },
  });
  assert.equal(status, 401);
});

/* -------------------------- roles and permissions ----------------------- */

test('customers and riders are kept out of the admin console', async () => {
  assert.equal((await api('/api/admin/overview', { token: tokens.customer })).status, 403);
  assert.equal((await api('/api/admin/overview', { token: tokens.driver })).status, 403);
  assert.equal((await api('/api/admin/audit', { token: tokens.customer })).status, 403);
  assert.equal((await api('/api/rider/board', { token: tokens.customer })).status, 403);
});

test('the admin dashboard returns the numbers the console renders', async () => {
  const { status, body } = await api('/api/admin/overview', { token: tokens.admin });
  assert.equal(status, 200);
  for (const key of ['today', 'live', 'topItems', 'last14', 'team', 'ratings']) {
    assert.ok(key in body.stats, `${key} is present`);
  }
  assert.ok(Array.isArray(body.queue));
  assert.ok(Array.isArray(body.riders));
  assert.ok(body.settings.base_delivery_fee);
});

test('the kitchen can bump an order and the rider board follows', async () => {
  const placed = await placeOrder(tokens.customer);
  const id = placed.body.order.id;

  let current = placed.body.order;
  for (const expected of ['confirmed', 'preparing', 'ready']) {
    const bump = await api(`/api/admin/orders/${id}/bump`, { method: 'POST', token: tokens.admin });
    assert.equal(bump.status, 200, `bump ${expected}: ${JSON.stringify(bump.body)}`);
    current = bump.body.order;
    assert.equal(current.status, expected);
  }

  const board = await api('/api/rider/board', { token: tokens.driver });
  assert.equal(board.status, 200);
  assert.ok(['online', 'busy'].includes(board.body.driver.status));

  const done = await api(`/api/orders/${id}/transition`, {
    method: 'POST',
    token: tokens.admin,
    body: { to: 'completed' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.order.status, 'completed');
});

test('admin settings can close the store and the storefront reacts', async () => {
  const closed = await api('/api/admin/settings/toggle', {
    method: 'POST',
    token: tokens.admin,
    body: { key: 'accepting_orders', value: false },
  });
  assert.equal(closed.status, 200);

  const status = await api('/api/store/status');
  assert.equal(status.body.acceptingOrders, false);

  const rejected = await placeOrder(tokens.customer);
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error.message, /paused new orders/i);

  await api('/api/admin/settings/toggle', {
    method: 'POST',
    token: tokens.admin,
    body: { key: 'accepting_orders', value: true },
  });
  const reopened = await api('/api/store/status');
  assert.equal(reopened.body.acceptingOrders, true);
});

test('the admin can toggle a dish off the menu and back on', async () => {
  const chips = await findItem('chips');

  const off = await api(`/api/admin/menu/items/${chips.id}`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { is_available: false },
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.item.soldOut, true);

  const blocked = await api('/api/orders/quote', {
    method: 'POST',
    body: {
      fulfilment: 'collection',
      items: [{ itemId: chips.id, qty: 1, optionIds: [chips.optionGroups[0].options[0].id] }],
    },
  });
  assert.equal(blocked.body.canCheckout, false);

  await api(`/api/admin/menu/items/${chips.id}`, {
    method: 'PATCH',
    token: tokens.admin,
    body: { is_available: true },
  });
  const back = await api('/api/menu/items/chips');
  assert.equal(back.body.item.soldOut, false);
});

test('rudimentary abuse cannot hand in a negative price', async () => {
  const chips = await findItem('chips');
  const { status } = await api('/api/orders/quote', {
    method: 'POST',
    body: {
      fulfilment: 'collection',
      items: [{ itemId: chips.id, qty: -5, optionIds: [chips.optionGroups[0].options[0].id] }],
    },
  });
  assert.equal(status, 422);
});

/* --------------------------------- SSE ---------------------------------- */

test('the live feed streams order events to a customer and supports replay', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?topics=orders`, {
    headers: { authorization: `Bearer ${tokens.customer}` },
    signal: controller.signal,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Read the greeting frame so we know the stream is live.
  while (!buffer.includes('event: hello')) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  assert.match(buffer, /event: hello/);

  const placed = await placeOrder(tokens.customer);
  const orderId = placed.body.order.id;

  const deadline = Date.now() + 5000;
  let sawCreated = false;
  let lastEventId = null;

  while (Date.now() < deadline && !sawCreated) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes('order.created')) {
      sawCreated = true;
      const match = buffer.match(/id: (\d+)\nevent: order\.created/);
      if (match) lastEventId = match[1];
    }
  }
  controller.abort();

  assert.equal(sawCreated, true, 'the customer receives their order.created event');
  assert.ok(lastEventId, 'events carry an id for replay');

  // Now reconnect late and make sure the missed event is replayed.
  const replayController = new AbortController();
  const replay = await fetch(`${base}/api/events?topics=orders&since=${Number(lastEventId) - 1}`, {
    headers: { authorization: `Bearer ${tokens.customer}` },
    signal: replayController.signal,
  });
  const replayReader = replay.body.getReader();
  const replayBuffer = await replayReader.read();
  const text = decoder.decode(replayBuffer.value, { stream: true });
  replayController.abort();

  assert.match(text, /"orderId":\d+/);
  assert.ok(text.includes(String(orderId)) || /event: order\.created/.test(text));
});

test('the live feed refuses kitchen topics to a customer', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events?topics=admin,staff`, {
    headers: { authorization: `Bearer ${tokens.customer}` },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  reader.cancel();
  controller.abort();

  const text = new TextDecoder().decode(first.value);
  const hello = JSON.parse(text.split('data: ')[1].split('\n')[0]);
  assert.ok(hello.topics.includes('public'));
  assert.ok(hello.topics.includes('orders'));
  assert.ok(hello.topics.some((topic) => topic.startsWith('user:')));
  assert.equal(hello.topics.includes('admin'), false, 'a customer never joins the admin channel');
  assert.equal(hello.topics.includes('staff'), false);
});

/* ------------------------------- tracking ------------------------------- */

test('rider progress is visible to the customer in real time', async () => {
  const wings = await findItem('dunked-wings');
  const optionIds = wings.optionGroups.filter((g) => g.required).map((g) => g.options[0].id);

  const placed = await api('/api/orders', {
    method: 'POST',
    token: tokens.customer,
    headers: { 'idempotency-key': `api-delivery-${Date.now()}` },
    body: {
      fulfilment: 'delivery',
      items: [{ itemId: wings.id, qty: 2, optionIds }],
      address: { line1: '1123 Malamulele Main Road', suburb: 'Malamulele B', lat: -22.9611, lng: 30.7195 },
      paymentMethod: 'card',
    },
  });
  assert.equal(placed.status, 201);
  const id = placed.body.order.id;

  for (const to of ['confirmed', 'preparing', 'ready']) {
    const step = await api(`/api/orders/${id}/transition`, { method: 'POST', token: tokens.admin, body: { to } });
    assert.equal(step.status, 200, `${to} failed: ${JSON.stringify(step.body)}`);
  }

  // Auto-dispatch may already have grabbed it; otherwise assign explicitly.
  let tracked = (await api(`/api/orders/${id}`, { token: tokens.admin })).body.order;
  if (tracked.status !== 'assigned') {
    const riders = await api('/api/admin/riders', { token: tokens.admin });
    const free = riders.body.riders.find((r) => r.canTakeOrders);
    const assigned = await api(`/api/admin/orders/${id}/assign`, {
      method: 'POST',
      token: tokens.admin,
      body: { driverId: free.id },
    });
    assert.equal(assigned.status, 200, `assign failed: ${JSON.stringify(assigned.body)}`);
    tracked = assigned.body.order;
  }
  assert.equal(tracked.status, 'assigned');
  const riderName = tracked.driver.name;
  assert.ok(riderName);

  const riderToken = riderName.includes('Sipho') ? tokens.driver : tokens.driver2;
  for (const to of ['picked_up', 'on_the_way', 'delivered']) {
    const step = await api(`/api/rider/orders/${id}/progress`, {
      method: 'POST',
      token: riderToken,
      body: { to },
    });
    assert.equal(step.status, 200, `${to} accepted`);
  }

  const afterRide = await api(`/api/orders/${id}`, { token: tokens.customer });
  assert.equal(afterRide.body.order.status, 'delivered');
  assert.equal(
    afterRide.body.order.timeline.currentIndex,
    afterRide.body.order.timeline.steps.indexOf('delivered'),
  );

  const rated = await api(`/api/orders/${id}/rate`, {
    method: 'POST',
    token: tokens.customer,
    body: { stars: 5, comment: 'Still warm!' },
  });
  assert.equal(rated.status, 201);
});

test('the rider sees an empty board when offline, and the storefront hides delivery', async () => {
  // Take every rider off shift.
  const riders = await api('/api/admin/riders', { token: tokens.admin });
  for (const rider of riders.body.riders) {
    await api(`/api/admin/riders/${rider.id}`, {
      method: 'PATCH',
      token: tokens.admin,
      body: { status: 'offline' },
    });
  }

  const status = await api('/api/store/status');
  assert.equal(status.body.delivery.available, false);
  assert.match(status.body.delivery.reason, /No riders are on shift|riders are offline|out on deliveries/);

  const offline = await api('/api/rider/status', {
    method: 'POST',
    token: tokens.driver,
    body: { status: 'online' },
  });
  // A rider may come back online themselves.
  assert.equal(offline.status, 200);

  const storeAgain = await api('/api/store/status');
  assert.equal(storeAgain.body.delivery.available, true);
});
