/**
 * Test bootstrap. Every suite gets its own throwaway SQLite file and its own
 * HTTP server on an ephemeral port, so tests never tread on each other or on
 * your development data.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'khanyi-test-'));
process.env.KHANYI_DATA_DIR = tmpRoot;
process.env.KHANYI_DB = path.join(tmpRoot, 'test.db');
process.env.KHANYI_SECRET = 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';
process.env.KHANYI_DEMO = '1';

const { createApp } = await import('../src/app.js');
const { seedDatabase } = await import('../src/db/seed.js');

export const dataDir = tmpRoot;

let server;
let baseUrl;

// Migrate + seed straight away so unit tests can import services directly
// without having to remember to bootstrap the database themselves.
seedDatabase({ force: true });

export async function startServer() {
  if (server) return baseUrl;
  seedDatabase({ force: true });
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return baseUrl;
}

export async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

/** Thin fetch wrapper: JSON in, JSON out, no silent failures. */
export async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const response = await fetch(`${baseUrl || (await startServer())}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

export async function login(email, password = 'demo1234') {
  const { body } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return body.token;
}

export const tokens = {};

export async function primeTokens() {
  tokens.admin = await login('admin@demo.kk');
  tokens.customer = await login('customer@demo.kk');
  tokens.driver = await login('driver@demo.kk');
  tokens.driver2 = await login('thabo.rider@demo.kk');
  return tokens;
}

/** Grab a menu item id by slug, plus its first required single-group option. */
export async function findItem(slug) {
  const { body } = await api('/api/menu?all=1');
  for (const category of body.categories) {
    for (const item of category.items) {
      if (item.slug === slug) return item;
    }
  }
  throw new Error(`menu item ${slug} not found`);
}
