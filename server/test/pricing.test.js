import assert from 'node:assert/strict';
import test from 'node:test';

import './helpers.js';
import { fullMenu, getItem, getItemDetail, isSellable } from '../src/services/menu.js';

/**
 * Build a legal basket line: every required choice group gets its first
 * option, exactly as the storefront's UI would submit it.
 */
function cartItem(slug, qty = 1, extraOptions = []) {
  const item = getItemDetail(slug);
  const required = item.optionGroups
    .filter((group) => group.required)
    .map((group) => group.options[0].id);
  return { itemId: item.id, qty, optionIds: [...required, ...extraOptions] };
}
import { priceCart, lineUnitPrice } from '../src/services/pricing.js';

test('the full menu mirrors the shop poster', () => {
  const menu = fullMenu();
  const names = menu.map((category) => category.name);
  assert.deepEqual(names, [
    'Wings',
    'Sandwiches & Chips',
    'Platters',
    'Indulgent Desserts',
    'Sweet Treats & Bakery',
    'Popcorn Bar',
    'Drinks',
  ]);

  const wings = menu[0].items[0];
  assert.equal(wings.name, 'Dunked Wings');
  assert.equal(wings.base_price, 2500, 'small dunked wings are R25 on the poster');
  const portion = wings.optionGroups.find((g) => g.name === 'Portion');
  assert.equal(portion.required, true);
  assert.deepEqual(
    portion.options.map((o) => [o.name, o.price_delta]),
    [['Small (6 wings)', 0], ['Medium (10 wings)', 1000], ['Large (15 wings)', 2000]],
  );

  const popcorn = menu.find((c) => c.slug === 'popcorn');
  assert.equal(popcorn.items.length, 5);
  assert.equal(popcorn.items[0].base_price, 1500, 'classic salted popcorn is R15');
});

test('option prices are added to the base price', () => {
  const item = getItem('dunked-wings');
  const groups = fullMenu()[0].items[0].optionGroups;
  const medium = groups[0].options[1].id;
  const hotSauce = groups[1].options[1].id;

  const { unitPrice, options } = lineUnitPrice(item, groups, [medium, hotSauce]);
  assert.equal(unitPrice, 2500 + 1000);
  assert.equal(options.length, 2);
});

test('an option from another dish is rejected', () => {
  const item = getItem('chips');
  const wingsGroups = fullMenu()[0].items[0].optionGroups;
  assert.throws(
    () => lineUnitPrice(item, fullMenu()[1].items[1].optionGroups, [wingsGroups[0].options[2].id]),
    /does not offer that option/,
  );
});

test('a required choice cannot be skipped', () => {
  const item = getItem('dunked-wings');
  const groups = fullMenu()[0].items[0].optionGroups;
  assert.throws(() => lineUnitPrice(item, groups, []), /Please choose Portion/);
});

test('multi choice groups enforce their pick limit', () => {
  const item = getItem('dunked-wings');
  const groups = fullMenu()[0].items[0].optionGroups;
  const sauce = groups.find((g) => g.name === 'Sauce');
  const portion = groups.find((g) => g.name === 'Portion').options[0].id;
  const tooMany = [portion, ...sauce.options.slice(0, 3).map((o) => o.id)];
  assert.throws(() => lineUnitPrice(item, groups, tooMany), /at most 2 choice/);
});

test('collection orders never pay a delivery fee', () => {
  const quote = priceCart({
    items: [cartItem('toasted-sandwich', 2)],
    fulfilment: 'collection',
  });
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.subtotal, 9000);
  assert.equal(quote.total, 9000);
});

test('delivery fee grows with distance and is waived over the threshold', () => {
  
  const near = priceCart({
    items: [cartItem('toasted-sandwich', 2)],
    fulfilment: 'delivery',
    address: { line1: 'Two streets away', lat: -22.96, lng: 30.73 },
  });
  const far = priceCart({
    items: [cartItem('toasted-sandwich', 4)],
    fulfilment: 'delivery',
    address: { line1: 'Out at the villages', lat: -22.99, lng: 30.79 },
  });

  assert.ok(near.deliveryFee > 0, 'a short ride still costs the call-out fee');
  assert.equal(near.deliveryFee, 1200 + Math.round(450 * near.distanceKm));
  assert.ok(far.distanceKm > near.distanceKm);
});

test('anything beyond the delivery radius is refused, collection still works', () => {
    const quote = priceCart({
    items: [cartItem('toasted-sandwich', 2)],
    fulfilment: 'delivery',
    address: { line1: 'Polokwane city centre', lat: -23.9045, lng: 29.4689 },
  });
  assert.equal(quote.canCheckout, false);
  assert.ok(quote.issues.some((issue) => issue.code === 'out_of_radius'));
});

test('minimum order is enforced with a helpful message', () => {
  const quote = priceCart({
    items: [cartItem('water-500ml', 1)],
    fulfilment: 'collection',
  });
  assert.equal(quote.canCheckout, false);
  const issue = quote.issues.find((i) => i.code === 'min_order');
  assert.match(issue.message, /Minimum order is R25/);
});

test('a percentage promo reduces the total, a fixed one is capped by the basket', () => {
  
  const percent = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'collection',
    promoCode: 'WINGS10',
  });
  assert.equal(percent.promoDiscount, Math.round(75000 * 0.1));
  assert.equal(percent.total, 75000 - 7500);

  const fixed = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'collection',
    promoCode: 'TREAT50',
  });
  assert.equal(fixed.promoDiscount, 5000);
});

test('a promo under its minimum spend is a warning, not a crash', () => {
  const quote = priceCart({
    items: [cartItem('cupcake-box', 1)],
    fulfilment: 'collection',
    promoCode: 'PLATTERDAY',
  });
  assert.equal(quote.promoDiscount, 0);
  assert.match(quote.promoMessage, /minimum spend/i);
});

test('free delivery promo zeroes the fee', () => {
  const quote = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'delivery',
    address: { line1: 'Main road', lat: -22.96, lng: 30.73 },
    promoCode: 'FREERIDE',
  });
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.promo.kind, 'free_delivery');
});

test('loyalty points redeem at their cent value and cannot exceed the basket', () => {
    const customer = { id: 1, loyalty_points: 100 }; // 100 points × 10c = R10

  const quote = priceCart({
    items: [cartItem('toasted-sandwich', 2)],
    fulfilment: 'collection',
    redeemPoints: 100,
    user: customer,
  });
  assert.equal(quote.pointsUsed, 100);
  assert.equal(quote.pointsDiscount, 1000);
  assert.equal(quote.total, 9000 - 1000);

  const greedy = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'collection',
    redeemPoints: 100,
    user: customer,
  });
  assert.ok(greedy.pointsUsed * 10 <= greedy.subtotal, 'cannot redeem more than the food is worth');
});

test('points below the redemption floor are ignored with an explanation', () => {
  const quote = priceCart({
    items: [cartItem('toasted-sandwich', 2)],
    fulfilment: 'collection',
    redeemPoints: 10,
    user: { id: 1, loyalty_points: 10 },
  });
  assert.equal(quote.pointsUsed, 0);
  assert.ok(quote.issues.some((i) => i.code === 'points'));
});

test('sold-out items block checkout but still appear in the basket', () => {
  const item = getItem('cake-slice');
  assert.equal(isSellable({ ...item, track_stock: 1, stock: 0 }), false);

  const quote = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'collection',
  });
  assert.ok(quote.subtotal > 0);
  assert.equal(quote.blocked, false);
});

test('quantities are merged per line and clamped to sane limits', () => {
    const quote = priceCart({
    items: [cartItem('chips', 999)],
    fulfilment: 'collection',
  });
  assert.equal(quote.lines[0].qty, 50, 'a single line cannot exceed 50');
});

test('an empty basket is refused outright', () => {
  assert.throws(() => priceCart({ items: [] }), /basket is empty/i);
});

test('ETA grows with the queue and the ride', () => {
    const collection = priceCart({ items: [cartItem('ultimate-sharing-platter', 1)], fulfilment: 'collection' });
  const delivery = priceCart({
    items: [cartItem('ultimate-sharing-platter', 1)],
    fulfilment: 'delivery',
    address: { line1: 'Somewhere', lat: -22.98, lng: 30.75 },
  });
  assert.ok(delivery.etaMinutes > collection.etaMinutes, 'a ride takes longer than a walk-in');
  assert.ok(collection.etaMinutes >= 15);
});
