import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config.js';
import migrations from './migrations.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);

// Pragmas: WAL keeps readers (the live dashboards) from blocking the
// kitchen's writes; foreign keys are enforced in SQLite only when asked.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Run every migration that has not been applied yet, in a transaction. */
export function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(db.prepare('SELECT id FROM _migrations').all().map((r) => r.id));
  const run = db.transaction((migration) => {
    db.exec(migration.sql);
    db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(migration.id);
  });

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    run(migration);
    count += 1;
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * Small helpers so route code reads like prose rather than string soup
 * ------------------------------------------------------------------ */

export const all = (sql, params = []) => db.prepare(sql).all(...params);
export const get = (sql, params = []) => db.prepare(sql).get(...params);
export const run = (sql, params = []) => db.prepare(sql).run(...params);

/** Wrap a function so every call runs in one SQLite transaction. */
export function tx(fn) {
  return db.transaction(fn);
}

/**
 * Lazily prepare a statement. Necessary because some modules are imported
 * before `migrate()` runs, and better-sqlite3 compiles statements eagerly —
 * a top-level prepare against a table that does not exist yet would throw
 * at import time.
 */
export function lazy(sql) {
  let statement = null;
  const ready = () => (statement ??= db.prepare(sql));
  return {
    get: (...params) => ready().get(...params),
    all: (...params) => ready().all(...params),
    run: (...params) => ready().run(...params),
  };
}

/** Read a settings row, falling back to a default. */
export function setting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function settingInt(key, fallback = 0) {
  const raw = setting(key, null);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function settingBool(key, fallback = false) {
  const raw = setting(key, null);
  if (raw === null) return fallback;
  return raw === '1' || raw === 'true';
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

export function audit({ actor, action, entity = '', entityId = '', meta = {} }) {
  db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, action, entity, entity_id, meta)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    actor?.id ?? null,
    actor?.name ?? 'system',
    action,
    entity,
    String(entityId ?? ''),
    JSON.stringify(meta),
  );
}

export const isSeeded = () =>
  db.prepare('SELECT COUNT(*) AS n FROM menu_items').get().n > 0;

export default db;
