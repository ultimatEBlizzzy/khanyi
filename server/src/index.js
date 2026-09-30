import config from './config.js';
import { createApp } from './app.js';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log('');
  console.log("  ┌───────────────────────────────────────────────┐");
  console.log("  │   Khanyisile's Kitchen — ordering platform    │");
  console.log('  └───────────────────────────────────────────────┘');
  console.log(`   API       http://${shown}:${config.port}/api`);
  console.log(`   Health    http://${shown}:${config.port}/api/health`);
  console.log(`   Live feed http://${shown}:${config.port}/api/events`);
  console.log(`   Data      ${config.dbFile}`);
  console.log('');
});

/** Long-running SSE connections must not be cut off by a proxy timeout. */
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

function shutdown(signal) {
  console.log(`\n[${signal}] closing the kitchen…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default server;
