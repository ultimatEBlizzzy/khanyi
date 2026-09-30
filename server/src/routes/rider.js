import express from 'express';
import { get, all, run } from '../db/index.js';
import { ApiError, asyncHandler, send } from '../lib/http.js';
import v from '../lib/validate.js';
import { requireRole } from '../middleware/auth.js';
import {
  riderBoard, setDriverStatus, claimOrder, listRiders, refreshDriverStatus,
} from '../services/dispatch.js';
import { transition, getOrderById } from '../services/orders.js';

const router = express.Router();

// Everything under /api/rider is for riders (admins may peek for support).
router.use(requireRole('driver', 'admin'));

const requireDriver = (req) => {
  const driver = get('SELECT * FROM drivers WHERE user_id = ?', [req.user.id]);
  if (!driver) throw ApiError.forbidden('No rider profile linked to this account');
  return driver;
};

/** The rider's whole day in one call: my runs, the open pool, my takings. */
router.get(
  '/board',
  asyncHandler((req, res) => send(res, riderBoard(req.user))),
);

router.post(
  '/status',
  asyncHandler((req, res) => {
    const body = v.object({ status: v.enum(['offline', 'online']) }).parse(req.body);
    if (req.user.role === 'admin') throw ApiError.forbidden('Admins do not go on shift');
    return send(res, { driver: setDriverStatus(req.user, body.status) });
  }),
);

/** Claim a ready order from the pool — first come, first served. */
router.post(
  '/orders/:id/claim',
  asyncHandler((req, res) => {
    const driver = requireDriver(req);
    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');
    if (order.driver_id && order.driver_id !== driver.id) {
      throw ApiError.conflict('Another rider has already claimed that run');
    }
    const updated = claimOrder(order.id, req.user);
    return send(res, { order: updated });
  }),
);

/**
 * Rider-driven moves. A rider may only advance their own delivery, and only
 * forward — the dispatch service refuses anything else.
 */
router.post(
  '/orders/:id/progress',
  asyncHandler((req, res) => {
    const body = v
      .object({
        to: v.enum(['picked_up', 'on_the_way', 'delivered']),
        note: v.text({ max: 200 }).optional(),
      })
      .parse(req.body);

    const driver = requireDriver(req);
    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');
    if (order.driver_id !== driver.id) throw ApiError.forbidden('That run is not yours');

    const updated = transition(order.id, body.to, { actor: req.user, note: body.note ?? '' });
    return send(res, { order: updated });
  }),
);

/** Hand the run back to the pool with a reason (breakdown, load too big). */
router.post(
  '/orders/:id/release',
  asyncHandler(async (req, res) => {
    const body = v.object({ reason: v.text({ max: 200 }).optional() }).parse(req.body ?? {});
    const driver = requireDriver(req);
    const order = getOrderById(Number(req.params.id));
    if (!order) throw ApiError.notFound('Order not found');
    if (order.driver_id !== driver.id) throw ApiError.forbidden('That run is not yours');
    if (['picked_up', 'on_the_way'].includes(order.status)) {
      throw ApiError.conflict('You have the food — phone the store to hand this run over');
    }

    const previousStatus = order.status;
    run('UPDATE orders SET driver_id = NULL, status = "ready", updated_at = datetime(\'now\') WHERE id = ?', [
      order.id,
    ]);
    run(
      `INSERT INTO order_events (order_id, from_state, to_state, actor_name, actor_role, note)
       VALUES (?, ?, 'ready', ?, 'driver', ?)`,
      [order.id, previousStatus, req.user.name, body.reason ?? 'Released back to the pool'],
    );
    refreshDriverStatus(driver.id);

    // Re-publish so the admin console and the other riders see it instantly.
    const { hub } = await import('../services/events.js');
    hub.publish(['orders', 'staff', 'admin', 'drivers'], 'order.updated', {
      orderId: order.id,
      code: order.code,
      from: previousStatus,
      status: 'ready',
      statusLabel: 'Back in the pool',
      note: body.reason ?? 'Released by rider',
    });

    return send(res, { order: getOrderById(order.id) });
  }),
);

router.get(
  '/earnings',
  asyncHandler((req, res) => {
    const driver = requireDriver(req);
    const days = all(
      `SELECT date(completed_at) AS day,
              COUNT(*) AS deliveries,
              COALESCE(SUM(delivery_fee),0) AS fees,
              COALESCE(SUM(total),0) AS order_value
         FROM orders
        WHERE driver_id = ? AND status IN ('delivered','completed') AND completed_at IS NOT NULL
        GROUP BY day ORDER BY day DESC LIMIT 14`,
      [driver.id],
    );
    const totals = get(
      `SELECT COUNT(*) AS deliveries, COALESCE(SUM(delivery_fee),0) AS fees
         FROM orders WHERE driver_id = ? AND status IN ('delivered','completed')`,
      [driver.id],
    );
    return send(res, {
      rider: { id: driver.id, vehicle: driver.vehicle, rating: driver.rating },
      days,
      totals,
      /** The store pays riders R10 per completed run plus the delivery fee share. */
      payoutModel: { perDelivery: 1000, feeShare: 0.5 },
    });
  }),
);

/** Support view: who is on shift right now. */
router.get(
  '/fleet',
  asyncHandler((req, res) => {
    if (req.user.role !== 'admin') throw ApiError.forbidden('Admins only');
    return send(res, { riders: listRiders() });
  }),
);

export default router;
