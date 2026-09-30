/**
 * Seed the shop.
 *
 *   node src/db/seed.js            # only if the menu is empty
 *   node src/db/seed.js --force    # wipe and rebuild (demo reset)
 *
 * Beyond the catalogue this also fabricates two weeks of trading history so
 * the admin dashboard, the rider earnings screen and the analytics actually
 * have something to show in a fresh checkout.
 */
import { db, migrate, run, all, get, setSetting } from './index.js';
import { hashPassword } from '../lib/crypto.js';
import { seedDefaults } from '../services/settings.js';
import { categories as catalogue, promos, demoUsers } from './seed-data.js';

/* --------------------------- deterministic RNG -------------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261001);
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (min, max) => min + Math.floor(rand() * (max - min + 1));
const chance = (p) => rand() < p;

const WALK_IN_CUSTOMERS = [
  ['Rirhandzu Chauke', 'rirhandzu@demo.kk', '083 221 7788', 118],
  ['Musa Nkuna', 'musa@demo.kk', '079 445 2201', 40],
  ['Portia Shikwambane', 'portia@demo.kk', '072 118 9043', 64],
  ['Blessing Mabasa', 'blessing@demo.kk', '084 776 3390', 12],
  ['Karabo Maluleke', 'karabo@demo.kk', '078 902 5541', 96],
  ['Given Hlungwani', 'given@demo.kk', '071 553 8802', 150],
  ['Precious Ngobeni', 'precious@demo.kk', '082 664 1127', 25],
  ['Tsepo Makhubele', 'tsepo@demo.kk', '074 331 9080', 8],
];

/* -------------------------------- helpers ------------------------------- */
const utc = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60_000);

const STORE = { lat: -22.9573, lng: 30.7273 };
const jitter = (base, spread = 0.03) => base + (rand() - 0.5) * spread * 2;

function wipe() {
  const tables = [
    'ratings', 'order_events', 'order_items', 'orders', 'drivers', 'addresses',
    'options', 'option_groups', 'menu_items', 'categories', 'promos', 'audit_log',
  ];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
  db.exec(`DELETE FROM users WHERE email LIKE '%@demo.kk'`);
  db.exec('DELETE FROM sqlite_sequence');
  db.exec('PRAGMA foreign_keys = ON');
}

/* --------------------------------- seed --------------------------------- */
export function seedDatabase({ force = false } = {}) {
  migrate();
  seedDefaults();

  const existing = get('SELECT COUNT(*) AS n FROM menu_items').n;
  if (existing > 0 && !force) return { seeded: false, reason: 'menu already populated' };

  if (force) wipe();

  const summary = { seeded: true, categories: 0, items: 0, users: 0, orders: 0 };

  const seed = db.transaction(() => {
    /* ------------------------------ users ------------------------------ */
    const insertUser = db.prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, loyalty_points)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const userIds = {};
    for (const person of demoUsers) {
      const info = insertUser.run(
        person.name, person.email, person.phone, hashPassword(person.password),
        person.role, person.loyalty ?? 0,
      );
      const id = Number(info.lastInsertRowid);
      userIds[person.email] = id;

      for (const address of person.addresses ?? []) {
        run(
          `INSERT INTO addresses (user_id, label, line1, suburb, city, notes, lat, lng, is_default)
           VALUES (?, ?, ?, ?, 'Malamulele', ?, ?, ?, ?)`,
          [id, address.label, address.line1, address.suburb, address.notes, address.lat, address.lng, address.isDefault],
        );
      }
      if (person.driver) {
        run(
          `INSERT INTO drivers (user_id, vehicle, plate, zone, status, rating, deliveries)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, person.driver.vehicle, person.driver.plate, person.driver.zone, person.driver.status,
            person.driver.rating, person.driver.deliveries],
        );
      }
    }
    summary.users = Object.keys(userIds).length;

    // Regulars who keep the analytics interesting.
    const customerIds = [userIds['customer@demo.kk'], userIds['tinyiko@demo.kk']];
    for (const [name, email, phone, loyalty] of WALK_IN_CUSTOMERS) {
      const info = insertUser.run(name, email, phone, hashPassword('demo1234'), 'customer', loyalty);
      const id = Number(info.lastInsertRowid);
      customerIds.push(id);
      run(
        `INSERT INTO addresses (user_id, label, line1, suburb, city, notes, lat, lng, is_default)
         VALUES (?, 'Home', ?, 'Malamulele', 'Malamulele', '', ?, ?, 1)`,
        [id, `${between(10, 999)} ${pick(['Malamulele Main Road', 'Giyani Road', 'Hlanganani Street', 'Xikundu Road'])}`,
          jitter(STORE.lat), jitter(STORE.lng)],
      );
      summary.users += 1;
    }

    /* ---------------------------- catalogue ---------------------------- */
    const insertCategory = db.prepare('INSERT INTO categories (slug, name, blurb, icon, sort) VALUES (?, ?, ?, ?, ?)');
    const insertItem = db.prepare(
      `INSERT INTO menu_items (category_id, slug, name, description, base_price, badge, prep_minutes, track_stock, stock, sort)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertGroup = db.prepare(
      `INSERT INTO option_groups (item_id, name, kind, required, max_pick, sort) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertOption = db.prepare(
      `INSERT INTO options (group_id, name, price_delta, sort) VALUES (?, ?, ?, ?)`,
    );

    const itemIndex = [];
    catalogue.forEach((category, categoryIndex) => {
      const categoryId = Number(
        insertCategory.run(category.slug, category.name, category.blurb, category.icon, categoryIndex).lastInsertRowid,
      );
      summary.categories += 1;

      category.items.forEach((item, itemIndex2) => {
        const itemId = Number(
          insertItem.run(
            categoryId, item.slug, item.name, item.description, item.basePrice, item.badge ?? '',
            item.prepMinutes ?? 10, item.trackStock ? 1 : 0, item.stock ?? 0, itemIndex2,
          ).lastInsertRowid,
        );
        summary.items += 1;

        const groups = [];
        (item.groups ?? []).forEach((group, groupIndex) => {
          const groupId = Number(
            insertGroup.run(itemId, group.name, group.kind, group.required ? 1 : 0, group.maxPick ?? 1, groupIndex).lastInsertRowid,
          );
          const options = [];
          group.options.forEach((option, optionIndex) => {
            const optionId = Number(
              insertOption.run(groupId, option.name, option.delta ?? 0, optionIndex).lastInsertRowid,
            );
            options.push({ id: optionId, name: option.name, delta: option.delta ?? 0 });
          });
          groups.push({ id: groupId, name: group.name, required: Boolean(group.required), kind: group.kind, options });
        });

        itemIndex.push({
          id: itemId,
          name: item.name,
          price: item.basePrice,
          category: category.slug,
          groups,
          weight: category.slug === 'drinks' ? 3 : category.slug === 'popcorn' ? 2 : category.slug === 'platters' ? 0.4 : 2.4,
        });
      });
    });

    /* ------------------------------ promos ----------------------------- */
    for (const promo of promos) {
      run(
        `INSERT INTO promos (code, kind, value, min_subtotal, max_uses, description, expires_at, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [promo.code, promo.kind, promo.value, promo.minSubtotal, promo.maxUses, promo.description, promo.expiresAt],
      );
    }

    /* ------------------------- trading history -------------------------- */
    const riders = all('SELECT d.id, d.vehicle FROM drivers d ORDER BY d.id');
    const inserted = buildHistory({ customerIds, itemIndex, riders });
    summary.orders = inserted;

    /* --------------------------- settings bits -------------------------- */
    setSetting('store_open', '1');
    setSetting('accepting_orders', '1');
    setSetting('auto_assign_riders', '1');
    setSetting('announcement', "Wings, platters & sweet treats — free delivery over R200 across Malamulele.");

    run(
      `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
       VALUES (?, 'Khanyisile Mabuza', 'seed.initial', 'system', '0', ?)`,
      [userIds['admin@demo.kk'], JSON.stringify({ note: 'Seeded catalogue and demo trading history' })],
    );
  });

  seed();
  return summary;
}

/* --------------------------- history generator --------------------------- */

function weightedItem(itemIndex) {
  const total = itemIndex.reduce((sum, item) => sum + item.weight, 0);
  let roll = rand() * total;
  for (const item of itemIndex) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return itemIndex[itemIndex.length - 1];
}

function buildHistory({ customerIds, itemIndex, riders }) {
  const insertOrder = db.prepare(
    `INSERT INTO orders (
       code, user_id, fulfilment, status, subtotal, delivery_fee, discount, total,
       payment_method, promo_code, points_earned, points_redeemed, customer_name, customer_phone,
       address_line, address_suburb, address_notes, lat, lng, distance_km, eta_minutes,
       driver_id, notes, created_at, updated_at, confirmed_at, ready_at, dispatched_at, completed_at, cancelled_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLine = db.prepare(
    `INSERT INTO order_items (order_id, item_id, name, unit_price, qty, line_total, options_json, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, '')`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO order_events (order_id, from_state, to_state, actor_name, actor_role, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertRating = db.prepare(
    `INSERT INTO ratings (order_id, user_id, stars, comment, created_at) VALUES (?, ?, ?, ?, ?)`,
  );

  const customerRows = customerIds.map((id) => get('SELECT id, name, phone FROM users WHERE id = ?', [id]));
  const addressRows = all('SELECT * FROM addresses ORDER BY user_id');
  const addressesByUser = new Map();
  for (const address of addressRows) {
    if (!addressesByUser.has(address.user_id)) addressesByUser.set(address.user_id, []);
    addressesByUser.get(address.user_id).push(address);
  }

  const now = new Date();
  let count = 0;
  let seq = 0;

  for (let dayOffset = 13; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(now);
    day.setUTCDate(day.getUTCDate() - dayOffset);
    const isWeekend = [0, 6].includes(day.getUTCDay());
    const ordersToday = between(isWeekend ? 8 : 5, isWeekend ? 14 : 10);

    for (let i = 0; i < ordersToday; i += 1) {
      // Lunch and supper peaks, like a real Friday fryer.
      const hourRoll = rand();
      const hour = hourRoll < 0.32 ? between(11, 14) : hourRoll < 0.82 ? between(17, 21) : between(8, 16);
      const placed = new Date(day);
      placed.setUTCHours(hour, between(0, 59), between(0, 59), 0);

      // Leave today's most recent orders in flight.
      const isToday = dayOffset === 0;
      if (isToday && placed > now) continue;

      const customer = pick(customerRows);
      const addresses = addressesByUser.get(customer.id) ?? [];
      const isDelivery = chance(0.58);
      const address = addresses.length ? pick(addresses) : null;

      const lineCount = between(1, 3);
      const lines = [];
      let subtotal = 0;
      for (let l = 0; l < lineCount; l += 1) {
        const item = weightedItem(itemIndex);
        const qty = item.category === 'platters' ? 1 : between(1, 3);
        const chosen = [];
        for (const group of item.groups) {
          if (group.kind === 'single' && group.required) {
            const option = group.options[between(0, group.options.length - 1)];
            chosen.push({ group: group.name, name: option.name, priceDelta: option.delta, optionId: option.id });
          } else if (group.kind === 'multi' && group.required) {
            const option = group.options[between(0, group.options.length - 1)];
            chosen.push({ group: group.name, name: option.name, priceDelta: option.delta, optionId: option.id });
          }
        }
        const unitPrice = item.price + chosen.reduce((sum, o) => sum + o.priceDelta, 0);
        lines.push({ item, qty, unitPrice, lineTotal: unitPrice * qty, options: chosen });
        subtotal += unitPrice * qty;
      }

      const distanceKm = isDelivery && address?.lat
        ? Math.round(Math.hypot((address.lat - STORE.lat) * 111, (address.lng - STORE.lng) * 103) * 1.35 * 10) / 10
        : 0;
      const deliveryFee = isDelivery ? (subtotal >= 20000 ? 0 : 1200 + Math.round(distanceKm * 450)) : 0;
      const discount = chance(0.18) ? Math.round(subtotal * 0.1) : 0;
      const total = subtotal - discount + deliveryFee;

      const roll = rand();
      let status;
      if (!isToday) {
        status = roll < 0.07 ? 'cancelled' : 'completed';
      } else if (placed.getTime() < now.getTime() - 3 * 60 * 60 * 1000) {
        status = roll < 0.05 ? 'cancelled' : 'completed';
      } else if (placed.getTime() < now.getTime() - 70 * 60 * 1000) {
        status = pick(['completed', 'completed', 'completed', 'cancelled']);
      } else if (placed.getTime() < now.getTime() - 35 * 60 * 1000) {
        status = pick(['completed', 'delivered', 'on_the_way', 'completed']);
      } else {
        status = pick(['pending', 'confirmed', 'preparing', 'preparing', 'ready', 'assigned', 'on_the_way']);
      }

      const driver =
        isDelivery && ['assigned', 'picked_up', 'on_the_way', 'delivered', 'completed'].includes(status)
          ? pick(riders)
          : null;

      const confirmedAt = addMinutes(placed, between(1, 3));
      const preparingAt = addMinutes(confirmedAt, between(1, 4));
      const readyAt = addMinutes(preparingAt, between(12, 28));
      const pickedAt = addMinutes(readyAt, between(3, 12));
      const onWayAt = addMinutes(pickedAt, between(2, 6));
      const deliveredAt = addMinutes(onWayAt, isDelivery ? Math.max(5, Math.round(distanceKm * 3.4)) : 0);
      const completedAt = isDelivery ? addMinutes(deliveredAt, between(1, 4)) : addMinutes(readyAt, between(5, 20));
      const cancelledAt = addMinutes(placed, between(2, 12));

      const started = ['confirmed', 'preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'delivered'].includes(status);
      const readyish = ['ready', 'assigned', 'picked_up', 'on_the_way', 'delivered'].includes(status);
      const collected = ['picked_up', 'on_the_way', 'delivered'].includes(status);

      const finished = ['completed', 'delivered'].includes(status);
      const cancelled = ['cancelled', 'rejected'].includes(status);

      seq += 1;
      const code = `KK-${(0x100000 + seq * 7919).toString(32).toUpperCase().slice(-6)}`;

      const info = insertOrder.run(
        code,
        customer.id,
        isDelivery ? 'delivery' : 'collection',
        status,
        subtotal,
        deliveryFee,
        discount,
        total,
        pick(['cash', 'card', 'eft', 'snapscan']),
        discount > 0 ? 'WINGS10' : '',
        finished ? Math.round((subtotal - discount) / 1000) : 0,
        0,
        customer.name,
        customer.phone,
        isDelivery ? address?.line1 ?? '' : '',
        isDelivery ? address?.suburb ?? '' : '',
        isDelivery ? address?.notes ?? '' : '',
        isDelivery ? address?.lat ?? null : null,
        isDelivery ? address?.lng ?? null : null,
        distanceKm,
        isDelivery ? 30 + Math.round(distanceKm * 3) : 25,
        driver?.id ?? null,
        '',
        utc(placed),
        utc(finished ? completedAt : cancelled ? cancelledAt : placed),
        started ? utc(confirmedAt) : null,
        readyish ? utc(readyAt) : null,
        collected ? utc(pickedAt) : null,
        finished ? utc(completedAt) : null,
        cancelled ? utc(cancelledAt) : null,
      );

      const orderId = Number(info.lastInsertRowid);
      for (const line of lines) {
        insertLine.run(
          orderId, line.item.id, line.item.name, line.unitPrice, line.qty, line.lineTotal,
          JSON.stringify(line.options),
        );
      }

      insertEvent.run(orderId, null, 'pending', customer.name, 'customer', 'Order placed', utc(placed));
      if (started) insertEvent.run(orderId, 'pending', 'confirmed', 'Khanyisile Mabuza', 'admin', 'Ticket printed', utc(confirmedAt));
      if (['preparing', 'ready', 'assigned', 'picked_up', 'on_the_way', 'delivered'].includes(status)) {
        insertEvent.run(orderId, 'confirmed', 'preparing', 'Kitchen screen', 'admin', 'In the fryer', utc(preparingAt));
      }
      if (readyish) insertEvent.run(orderId, 'preparing', 'ready', 'Kitchen screen', 'admin', 'Packed and ready', utc(readyAt));
      if (driver) {
        insertEvent.run(orderId, 'ready', 'assigned', 'Khanyisile Mabuza', 'admin', `Assigned to rider #${driver.id}`, utc(addMinutes(readyAt, 2)));
      }
      if (collected) insertEvent.run(orderId, 'assigned', 'picked_up', 'Rider', 'driver', 'Collected from the kitchen', utc(pickedAt));
      if (['on_the_way', 'delivered'].includes(status)) {
        insertEvent.run(orderId, 'picked_up', 'on_the_way', 'Rider', 'driver', 'Leaving the store', utc(onWayAt));
      }
      if (['delivered', 'completed'].includes(status) && isDelivery) {
        insertEvent.run(orderId, 'on_the_way', 'delivered', 'Rider', 'driver', 'Handed to customer', utc(deliveredAt));
      }
      if (status === 'completed') {
        insertEvent.run(
          orderId,
          isDelivery ? 'delivered' : 'ready',
          'completed',
          isDelivery ? 'system' : 'Khanyisile Mabuza',
          isDelivery ? 'system' : 'admin',
          isDelivery ? 'Closed out' : 'Collected in store',
          utc(completedAt),
        );
      }
      if (cancelled) {
        insertEvent.run(orderId, 'pending', 'cancelled', customer.name, 'customer', 'Changed their mind', utc(cancelledAt));
      }

      if (finished && chance(0.62)) {
        const stars = chance(0.72) ? 5 : chance(0.7) ? 4 : 3;
        insertRating.run(
          orderId, customer.id, stars,
          stars === 5 ? pick(['Absolutely delicious!', 'Best wings in Malamulele 🔥', 'Fast delivery, still hot.'])
            : stars === 4 ? pick(['Lovely, will order again.', 'Great food, a little slow.'])
              : pick(['Tasty but the wait was long.']),
          utc(addMinutes(completedAt, between(20, 240))),
        );
      }
      count += 1;
    }
  }

  // Fold the new history into the rider counters so the fleet board adds up.
  db.exec(`
    UPDATE drivers SET deliveries = (
      SELECT COUNT(*) FROM orders o
       WHERE o.driver_id = drivers.id AND o.status IN ('delivered','completed')
    )
  `);

  return count;
}

/* --------------------------------- CLI ---------------------------------- */
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const force = process.argv.includes('--force');
  const result = seedDatabase({ force });
  if (result.seeded) {
    console.log(
      `[seed] ${result.categories} categories · ${result.items} dishes · ${result.users} accounts · ${result.orders} historical orders`,
    );
    console.log('[seed] demo logins — admin@demo.kk / driver@demo.kk / customer@demo.kk  (password: demo1234)');
  } else {
    console.log(`[seed] skipped — ${result.reason}. Use --force to rebuild.`);
  }
}

export default seedDatabase;
