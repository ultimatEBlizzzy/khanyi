import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import config from './config.js';
import { migrate, isSeeded } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { seedDefaults } from './services/settings.js';

import authRoutes from './routes/auth.js';
import storeRoutes from './routes/store.js';
import menuRoutes from './routes/menu.js';
import orderRoutes from './routes/orders.js';
import riderRoutes from './routes/rider.js';
import adminRoutes from './routes/admin.js';
import eventRoutes from './routes/events.js';

import { attachUser } from './middleware/auth.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { hub } from './services/events.js';

export function createApp() {
  // Schema + baseline data are ready before the first request is served.
  const applied = migrate();
  if (applied > 0) console.log(`[db] applied ${applied} migration(s)`);
  seedDefaults();
  if (!isSeeded()) {
    console.log('[db] empty database detected — seeding the menu');
    seedDatabase();
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '512kb' }));

  // A request id makes the logs greppable when a customer phones in.
  app.use((req, res, next) => {
    req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  app.use(attachUser);

  app.get('/api/health', (req, res) =>
    res.json({
      ok: true,
      service: "@khanyi/server",
      env: config.env,
      uptime: Math.round(process.uptime()),
      liveClients: hub.clients.size,
      time: new Date().toISOString(),
    }),
  );

  app.use('/api/auth', authRoutes);
  app.use('/api/store', storeRoutes);
  app.use('/api/menu', menuRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/rider', riderRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/events', eventRoutes);

  app.use('/api', notFound);

  // In production the same process also serves the built SPA, so a single
  // port is all a host has to expose.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

export default createApp;
