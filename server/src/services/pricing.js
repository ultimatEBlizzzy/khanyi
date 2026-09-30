import { all, get } from '../db/index.js';
import { ApiError } from '../lib/http.js';
import { roadKm, travelMinutes } from '../lib/geo.js';
import { getTunables } from './settings.js';

/**
 * The pricing engine.
 *
 * Everything money-related happens in ONE place so the storefront, the
 * kitchen screen and the database trigger all agree. Prices are integers in
 * cents — never floats — because 0.1 + 0.2 !== 0.3 and a cent lost per order
 * is a real bug, not a rounding curiosity.
 */

const MAX_QTY_PER_LINE = 50;

export function lineUnitPrice(item, groups, chosenOptionIds) {
  const allowed = new Map();
  for (const group of groups) for (const option of group.options) allowed.set(option.id, { option, group });

  let price = item.base_price;
  const picked = [];

  for (const optionId of chosenOptionIds) {
    const found = allowed.get(Number(optionId));
    if (!found) {
      throw ApiError.unprocessable(`"${item.name}" does not offer that option`, {
        field: 'optionIds',
        itemId: item.id,
      });
    }
    if (!found.option.is_available) {
      throw ApiError.conflict(`Option "${found.option.name}" is unavailable right now`, {
        itemId: item.id,
        optionId: found.option.id,
      });
    }
    price += found.option.price_delta;
    picked.push({ group: found.group, option: found.option });
  }

  // Required groups must be satisfied — a "choose your sauce" with no sauce
  // is the kind of thing that ruins a Friday night.
  for (const group of groups) {
    const inGroup = picked.filter((p) => p.group.id === group.id);
    if (group.required && inGroup.length === 0) {
      throw ApiError.unprocessable(`Please choose ${group.name} for "${item.name}"`, {
        field: 'optionIds',
        itemId: item.id,
        group: group.name,
      });
    }
    const limit = group.kind === 'multi' ? group.max_pick : 1;
    if (inGroup.length > limit) {
      throw ApiError.unprocessable(
        `"${item.name}" allows at most ${limit} choice(s) from ${group.name}`,
        { itemId: item.id, group: group.name },
      );
    }
  }

  return {
    unitPrice: Math.max(0, price),
    options: picked.map((p) => ({
      group: p.group.name,
      name: p.option.name,
      priceDelta: p.option.price_delta,
      optionId: p.option.id,
      groupId: p.group.id,
    })),
  };
}

function loadItemBundle(itemId) {
  const item = get('SELECT * FROM menu_items WHERE id = ?', [itemId]);
  if (!item) throw ApiError.unprocessable('One of the items is no longer on the menu', { itemId });

  const groups = all('SELECT * FROM option_groups WHERE item_id = ? ORDER BY sort, id', [itemId]).map(
    (group) => ({
      ...group,
      options: all('SELECT * FROM options WHERE group_id = ? ORDER BY sort, id', [group.id]),
    }),
  );
  return { item, groups };
}

export function cartAvailability(item) {
  if (!item.is_available) return 'Not available right now';
  if (item.track_stock && item.stock <= 0) return 'Sold out for today';
  return null;
}

/**
 * Price a cart.
 * @returns {{lines: object[], issues: object[], subtotal: number, ...}}
 */
export function priceCart({
  items = [],
  fulfilment = 'collection',
  address = null,
  promoCode = '',
  redeemPoints = 0,
  user = null,
  tunables = getTunables(),
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.unprocessable('Your basket is empty');
  }
  if (items.length > 40) {
    throw ApiError.unprocessable('That is a lot of lines — please split the order');
  }

  const issues = [];
  const lines = [];

  for (const raw of items) {
    const itemId = Number(raw.itemId ?? raw.item_id);
    if (!Number.isInteger(itemId)) throw ApiError.unprocessable('Each basket line needs an itemId');

    // Merge duplicates of the same item+options instead of showing the same
    // line twice; different options stay separate lines.
    const rawOptions = raw.optionIds ?? raw.options ?? [];
    const optionIds = [
      ...new Set((Array.isArray(rawOptions) ? rawOptions : [rawOptions]).map(Number).filter(Number.isInteger)),
    ].sort((a, b) => a - b);
    const qty = Math.max(1, Math.min(MAX_QTY_PER_LINE, Math.trunc(Number(raw.qty) || 1)));

    const { item, groups } = loadItemBundle(itemId);
    const soldOut = cartAvailability(item);
    if (soldOut) {
      issues.push({ type: 'error', code: 'sold_out', message: `"${item.name}" — ${soldOut.toLowerCase()}`, itemId });
      lines.push({
        itemId: item.id,
        name: item.name,
        image: item.image,
        qty,
        optionIds,
        options: [],
        unitPrice: item.base_price,
        lineTotal: 0,
        notes: String(raw.notes ?? '').slice(0, 200),
        blocked: true,
        issue: soldOut,
      });
      continue;
    }

    if (item.track_stock && qty > item.stock) {
      issues.push({
        type: 'warning',
        code: 'stock_clamped',
        message: `Only ${item.stock} × "${item.name}" left — quantity adjusted`,
        itemId,
      });
    }
    const effectiveQty = item.track_stock ? Math.min(qty, Math.max(1, item.stock)) : qty;

    const { unitPrice, options } = lineUnitPrice(item, groups, optionIds);

    lines.push({
      itemId: item.id,
      slug: item.slug,
      name: item.name,
      image: item.image,
      qty: effectiveQty,
      optionIds,
      options,
      unitPrice,
      lineTotal: unitPrice * effectiveQty,
      prepMinutes: item.prep_minutes,
      notes: String(raw.notes ?? '').slice(0, 200),
      blocked: false,
      issue: null,
    });
  }

  const blocked = lines.some((line) => line.blocked);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  /* ---------------------------- minimum order --------------------------- */
  if (!blocked && subtotal < tunables.minOrder) {
    issues.push({
      type: 'error',
      code: 'min_order',
      message: `Minimum order is R${(tunables.minOrder / 100).toFixed(0)} — add R${(
        (tunables.minOrder - subtotal) / 100
      ).toFixed(2)} more`,
    });
  }

  /* ------------------------------ delivery ------------------------------ */
  let distanceKm = 0;
  let deliveryFee = 0;
  let addressIssue = null;

  if (fulfilment === 'delivery') {
    const coords =
      address && Number.isFinite(address.lat) && Number.isFinite(address.lng)
        ? { lat: Number(address.lat), lng: Number(address.lng) }
        : null;

    if (coords) {
      distanceKm = roadKm(tunables.storeLocation, coords);
      if (distanceKm > tunables.deliveryRadiusKm) {
        addressIssue = `That address is ${distanceKm.toFixed(1)} km away — we deliver within ${tunables.deliveryRadiusKm} km of ${'Malamulele'}. Collection is still available.`;
        issues.push({ type: 'error', code: 'out_of_radius', message: addressIssue });
      }
    } else {
      issues.push({
        type: 'warning',
        code: 'no_coords',
        message: 'We could not pin that address on the map — the store will confirm the fee before riding out.',
      });
    }

    const rawFee = tunables.baseDeliveryFee + Math.round(tunables.perKmFee * distanceKm);
    const freeDelivery = tunables.freeDeliveryOver > 0 && subtotal >= tunables.freeDeliveryOver;
    deliveryFee = freeDelivery ? 0 : rawFee;
  }

  /* -------------------------------- promos ------------------------------ */
  const promo = promoCode ? validatePromo(promoCode, subtotal, tunables) : null;
  if (promoCode && promo && !promo.ok) {
    issues.push({ type: 'warning', code: 'promo', message: promo.message });
  }
  let promoDiscount = 0;
  if (promo?.ok) {
    if (promo.kind === 'percent') promoDiscount = Math.round((subtotal * promo.value) / 100);
    else if (promo.kind === 'fixed') promoDiscount = Math.min(subtotal, promo.value);
    else if (promo.kind === 'free_delivery') {
      promoDiscount = 0;
      deliveryFee = 0;
    }
  }

  /* ------------------------------- loyalty ------------------------------ */
  const maxRedeemablePoints = user
    ? Math.max(0, Math.floor(user.loyalty_points ?? 0))
    : 0;
  const requestedPoints = Math.max(0, Math.trunc(Number(redeemPoints) || 0));
  const redeemableCapByValue = Math.floor(
    Math.max(0, subtotal - promoDiscount) / Math.max(1, tunables.loyaltyPointValue),
  );
  const pointsUsed =
    requestedPoints >= tunables.minPointsToRedeem
      ? Math.min(requestedPoints, maxRedeemablePoints, redeemableCapByValue)
      : 0;

  if (requestedPoints > 0 && pointsUsed === 0 && !blocked) {
    issues.push({
      type: 'warning',
      code: 'points',
      message: `You need at least ${tunables.minPointsToRedeem} points to redeem (you have ${maxRedeemablePoints}).`,
    });
  }
  const pointsDiscount = pointsUsed * tunables.loyaltyPointValue;

  const discount = Math.min(subtotal, promoDiscount + pointsDiscount);
  const total = Math.max(0, subtotal - discount) + deliveryFee;
  const pointsEarned = Math.round((subtotal - discount) / 100 * tunables.loyaltyPointsPerRand);

  /* --------------------------------- ETA -------------------------------- */
  const kitchenMinutes = estimateKitchenMinutes(lines, tunables);
  const rideMinutes = fulfilment === 'delivery' ? travelMinutes(distanceKm, 'scooter') + 6 : 0;
  const etaMinutes =
    fulfilment === 'collection' ? kitchenMinutes + 5 : kitchenMinutes + rideMinutes + 5;

  return {
    lines,
    issues,
    fulfilment,
    subtotal,
    deliveryFee,
    promo: promo?.ok ? { code: promo.code, kind: promo.kind, value: promo.value, description: promo.description } : null,
    promoDiscount,
    promoMessage: promo && !promo.ok ? promo.message : '',
    pointsUsed,
    pointsDiscount,
    discount,
    total,
    distanceKm,
    etaMinutes,
    kitchenMinutes,
    pointsEarned,
    blocked,
    addressIssue,
    canCheckout: !blocked && issues.every((i) => i.type !== 'error'),
  };
}

export function estimateKitchenMinutes(lines, tunables = getTunables()) {
  const units = lines.reduce((sum, line) => sum + line.qty, 0);
  const slowest = lines.reduce((max, line) => Math.max(max, line.prepMinutes ?? 10), 0);
  const capacityDrain = Math.ceil((units / Math.max(1, tunables.prepCapacityPerHour)) * 60);
  return Math.max(10, slowest + capacityDrain);
}

export function validatePromo(code, subtotal = 0, tunables = getTunables()) {
  const promo = get('SELECT * FROM promos WHERE code = ? COLLATE NOCASE', [String(code).trim()]);
  if (!promo) return { ok: false, message: 'That promo code is not recognised' };
  if (!promo.is_active) return { ok: false, message: 'That promo has ended' };
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return { ok: false, message: 'That promo has expired' };
  }
  if (promo.max_uses > 0 && promo.uses >= promo.max_uses) {
    return { ok: false, message: 'That promo has been fully claimed' };
  }
  if (subtotal < promo.min_subtotal) {
    return {
      ok: false,
      message: `${promo.code} needs a minimum spend of R${(promo.min_subtotal / 100).toFixed(0)}`,
    };
  }
  return { ...promo, ok: true };
}

/** Public promo banner: what is live right now. */
export function activePromos() {
  return all(
    `SELECT code, kind, value, min_subtotal, description, expires_at
     FROM promos
     WHERE is_active = 1
       AND (expires_at IS NULL OR expires_at > datetime('now'))
       AND (max_uses = 0 OR uses < max_uses)
     ORDER BY id`,
  );
}

export const deliveryConfigFor = () => {
  const t = getTunables();
  return {
    baseFee: t.baseDeliveryFee,
    perKmFee: t.perKmFee,
    freeOver: t.freeDeliveryOver,
    radiusKm: t.deliveryRadiusKm,
    minOrder: t.minOrder,
    storeLocation: t.storeLocation,
  };
};

export default { priceCart, validatePromo, activePromos, estimateKitchenMinutes };
