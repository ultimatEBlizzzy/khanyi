import { db, setting, settingInt, setSetting } from '../db/index.js';

export const defaults = {
  store_open: '1',
  accepting_orders: '1',
  base_delivery_fee: '1200', // R12 call-out
  per_km_fee: '450', // R4.50 per km
  free_delivery_over: '35000', // free delivery over R350
  delivery_radius_km: '12',
  min_order: '2500', // R25 minimum order
  prep_capacity_per_hour: '18',
  busy_threshold_orders: '6',
  loyalty_points_per_rand: '0.1', // 1 point per R10 spent
  loyalty_point_value: '10', // 10c per point
  min_points_to_redeem: '50',
  store_lat: '-22.9573',
  store_lng: '30.7273',
  auto_assign_riders: '1',
  announcement: 'Wings, platters & sweet treats — delivery across Malamulele until 22:00.',
};

export const BOOLEAN_KEYS = ['store_open', 'accepting_orders', 'auto_assign_riders'];

/** Keys stored as numbers; everything else is text. */
export const NUMERIC_KEYS = new Set([
  'base_delivery_fee',
  'per_km_fee',
  'free_delivery_over',
  'delivery_radius_km',
  'min_order',
  'prep_capacity_per_hour',
  'busy_threshold_orders',
  'loyalty_points_per_rand',
  'loyalty_point_value',
  'min_points_to_redeem',
  'store_lat',
  'store_lng',
]);

export const isNumericKey = (key) => NUMERIC_KEYS.has(key);
export const isBooleanKey = (key) => BOOLEAN_KEYS.includes(key);

export function seedDefaults() {
  for (const [key, value] of Object.entries(defaults)) {
    if (setting(key, null) === null) setSetting(key, value);
  }
}

export function getConfig() {
  const out = {};
  for (const key of Object.keys(defaults)) {
    out[key] = setting(key, defaults[key]);
  }
  return out;
}

export function getTunables() {
  const raw = getConfig();
  return {
    storeOpen: raw.store_open === '1',
    acceptingOrders: raw.accepting_orders === '1',
    baseDeliveryFee: settingInt('base_delivery_fee', 1200),
    perKmFee: settingInt('per_km_fee', 450),
    freeDeliveryOver: settingInt('free_delivery_over', 35000),
    deliveryRadiusKm: settingInt('delivery_radius_km', 12),
    minOrder: settingInt('min_order', 2500),
    prepCapacityPerHour: settingInt('prep_capacity_per_hour', 18),
    busyThresholdOrders: settingInt('busy_threshold_orders', 6),
    loyaltyPointsPerRand: Number(setting('loyalty_points_per_rand', '0.1')),
    loyaltyPointValue: settingInt('loyalty_point_value', 10),
    minPointsToRedeem: settingInt('min_points_to_redeem', 50),
    storeLocation: {
      lat: Number(setting('store_lat', defaults.store_lat)),
      lng: Number(setting('store_lng', defaults.store_lng)),
    },
    announcement: setting('announcement', defaults.announcement),
  };
}

export function updateSettings(patch, actor) {
  const applied = {};
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in defaults)) continue; // unknown keys are ignored, not trusted
      if (NUMERIC_KEYS.has(key)) {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) continue;
        setSetting(key, Math.round(n * 100) / 100);
        applied[key] = String(Math.round(n * 100) / 100);
      } else {
        setSetting(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value).slice(0, 400));
        applied[key] = typeof value === 'boolean' ? (value ? '1' : '0') : String(value).slice(0, 400);
      }
    }
  })();

  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
     VALUES (?, ?, 'settings.update', 'settings', 'global', ?)`,
  ).run(actor?.id ?? null, actor?.name ?? 'system', JSON.stringify(applied));

  return getConfig();
}

export default { getTunables, getConfig, updateSettings, seedDefaults, defaults };
