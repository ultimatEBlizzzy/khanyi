import express from 'express';
import { subscribe, hub } from '../services/events.js';
import { send } from '../lib/http.js';
import { optionalAuth } from '../middleware/optionalAuth.js';

const router = express.Router();

/**
 * Live feed. Topics are chosen from the *verified* role on the token —
 * a customer cannot subscribe to the kitchen's private topic by editing
 * the query string.
 */
router.get('/', optionalAuth, (req, res) => {
  const topics = new Set(['public']);
  const role = req.user?.role;

  if (req.user) {
    topics.add(`user:${req.user.id}`);
    topics.add('orders');

    // What a role may listen to. The query string can only ever *narrow*
    // this list — never widen it — so a crafted URL cannot subscribe a
    // customer to the kitchen's private channel.
    const granted = new Set(['orders']);
    if (role === 'driver') granted.add('drivers');
    if (role === 'admin') {
      granted.add('drivers');
      granted.add('staff');
      granted.add('admin');
      granted.add('store');
    }

    if (req.query.topics) {
      for (const topic of String(req.query.topics).split(',')) {
        const clean = topic.trim();
        if (granted.has(clean)) topics.add(clean);
      }
    } else {
      for (const topic of granted) topics.add(topic);
    }
  }

  const since = req.get('last-event-id') ?? req.query.since;
  return subscribe(res, [...topics], { since });
});

router.get('/stats', (req, res) => send(res, { ...hub.stats(), clientCount: hub.clients.size }));

export default router;
