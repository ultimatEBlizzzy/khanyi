import express from 'express';
import config from '../config.js';
import { all, get } from '../db/index.js';
import { asyncHandler, send } from '../lib/http.js';
import { fullMenu, getItemDetail, stockRadar } from '../services/menu.js';
import { activePromos, deliveryConfigFor } from '../services/pricing.js';
import { getTunables } from '../services/settings.js';
import { deliveryAvailability } from '../services/dispatch.js';

const router = express.Router();

/**
 * The storefront's single bootstrap call: brand, trading hours, delivery
 * rules, live rider availability, promotions and the full menu.
 */
router.get(
  '/',
  asyncHandler((req, res) => {
    const tunables = getTunables();
    const includeUnavailable = req.query.all === '1';

    return send(res, {
      store: {
        ...config.store,
        open: tunables.storeOpen,
        acceptingOrders: tunables.acceptingOrders,
        hours: '06:00 – 22:00',
        announcement: tunables.announcement,
      },
      delivery: {
        ...deliveryConfigFor(),
        ...deliveryAvailability(),
      },
      minimumOrder: tunables.minOrder,
      loyalty: {
        pointsPerRand: tunables.loyaltyPointsPerRand,
        pointValue: tunables.loyaltyPointValue,
        minToRedeem: tunables.minPointsToRedeem,
      },
      promos: activePromos(),
      menu: fullMenu({ includeUnavailable }),
      lastUpdated: new Date().toISOString(),
    });
  }),
);

/** Lightweight liveness probe used by the storefront banner + rider app. */
router.get(
  '/status',
  asyncHandler((req, res) => {
    const tunables = getTunables();
    const activeOrders = get(
      `SELECT COUNT(*) AS n FROM orders
        WHERE status IN ('pending','confirmed','preparing','ready')`,
    ).n;
    const requestsPerHour = get(
      `SELECT COUNT(*) AS n FROM orders WHERE created_at >= datetime('now','-1 hour')`,
    ).n;

    return send(res, {
      open: tunables.storeOpen,
      acceptingOrders: tunables.acceptingOrders,
      busy: activeOrders >= tunables.busyThresholdOrders,
      queueDepth: activeOrders,
      load: Math.min(100, Math.round((requestsPerHour / Math.max(1, tunables.prepCapacityPerHour)) * 100)),
      loadState: requestsPerHour > tunables.prepCapacityPerHour ? 'heavy' : requestsPerHour > tunables.prepCapacityPerHour / 2 ? 'steady' : 'calm',
      delivery: deliveryAvailability(),
      hours: '06:00 – 22:00',
      serverTime: new Date().toISOString(),
    });
  }),
);

/** Sold-out / low-stock ticker for the storefront (“sold out today”). */
router.get(
  '/sold-out',
  asyncHandler((req, res) => {
    const items = all(
      `SELECT id, name FROM menu_items WHERE is_available = 0 OR (track_stock = 1 AND stock <= 0)`,
    );
    return send(res, { count: items.length, items });
  }),
);

export default router;
