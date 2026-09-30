import express from 'express';
import { asyncHandler, send } from '../lib/http.js';
import { fullMenu, getItemDetail } from '../services/menu.js';
import { activePromos } from '../services/pricing.js';

const router = express.Router();

router.get(
  '/',
  asyncHandler((req, res) => {
    const includeUnavailable = req.query.all === '1';
    const menu = fullMenu({ includeUnavailable });
    return send(res, {
      categories: menu,
      promos: activePromos(),
      itemCount: menu.reduce((sum, category) => sum + category.items.length, 0),
    });
  }),
);

router.get(
  '/items/:idOrSlug',
  asyncHandler((req, res) => send(res, { item: getItemDetail(req.params.idOrSlug) })),
);

export default router;
