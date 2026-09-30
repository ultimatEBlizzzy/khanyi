/**
 * Schema migrations. Each entry runs exactly once, in order, inside a
 * transaction, and is recorded in `_migrations`.
 */
export const migrations = [
  {
    id: '0001_core',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT    NOT NULL,
        email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        phone         TEXT    NOT NULL DEFAULT '',
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL DEFAULT 'customer'
                      CHECK (role IN ('customer', 'driver', 'admin')),
        loyalty_points INTEGER NOT NULL DEFAULT 0,
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE addresses (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label      TEXT    NOT NULL DEFAULT 'Home',
        line1      TEXT    NOT NULL,
        suburb     TEXT    NOT NULL DEFAULT '',
        city       TEXT    NOT NULL DEFAULT 'Malamulele',
        notes      TEXT    NOT NULL DEFAULT '',
        lat        REAL,
        lng        REAL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_addresses_user ON addresses(user_id);

      CREATE TABLE categories (
        id    INTEGER PRIMARY KEY AUTOINCREMENT,
        slug  TEXT NOT NULL UNIQUE,
        name  TEXT NOT NULL,
        blurb TEXT NOT NULL DEFAULT '',
        icon  TEXT NOT NULL DEFAULT '',
        sort  INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE menu_items (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id     INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        slug            TEXT    NOT NULL UNIQUE,
        name            TEXT    NOT NULL,
        description     TEXT    NOT NULL DEFAULT '',
        base_price      INTEGER NOT NULL,
        image           TEXT    NOT NULL DEFAULT '',
        badge           TEXT    NOT NULL DEFAULT '',
        track_stock     INTEGER NOT NULL DEFAULT 0,
        stock           INTEGER NOT NULL DEFAULT 0,
        is_available    INTEGER NOT NULL DEFAULT 1,
        prep_minutes    INTEGER NOT NULL DEFAULT 10,
        sort            INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_items_category ON menu_items(category_id);

      CREATE TABLE option_groups (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id  INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
        name     TEXT    NOT NULL,
        kind     TEXT    NOT NULL DEFAULT 'single' CHECK (kind IN ('single','multi')),
        required INTEGER NOT NULL DEFAULT 0,
        max_pick INTEGER NOT NULL DEFAULT 1,
        sort     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_groups_item ON option_groups(item_id);

      CREATE TABLE options (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    INTEGER NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
        name        TEXT    NOT NULL,
        price_delta INTEGER NOT NULL DEFAULT 0,
        is_available INTEGER NOT NULL DEFAULT 1,
        sort        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_options_group ON options(group_id);

      CREATE TABLE drivers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        vehicle    TEXT    NOT NULL DEFAULT 'scooter'
                   CHECK (vehicle IN ('bike','scooter','car')),
        plate      TEXT    NOT NULL DEFAULT '',
        status     TEXT    NOT NULL DEFAULT 'offline'
                   CHECK (status IN ('offline','online','busy')),
        zone       TEXT    NOT NULL DEFAULT 'Malamulele',
        rating     REAL    NOT NULL DEFAULT 5.0,
        deliveries INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE orders (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        code             TEXT    NOT NULL UNIQUE,
        user_id          INTEGER NOT NULL REFERENCES users(id),
        fulfilment       TEXT    NOT NULL CHECK (fulfilment IN ('collection','delivery')),
        status           TEXT    NOT NULL DEFAULT 'pending',
        subtotal         INTEGER NOT NULL DEFAULT 0,
        delivery_fee     INTEGER NOT NULL DEFAULT 0,
        discount         INTEGER NOT NULL DEFAULT 0,
        total            INTEGER NOT NULL DEFAULT 0,
        payment_method   TEXT    NOT NULL DEFAULT 'cash',
        promo_code       TEXT    NOT NULL DEFAULT '',
        points_earned    INTEGER NOT NULL DEFAULT 0,
        points_redeemed  INTEGER NOT NULL DEFAULT 0,
        customer_name    TEXT    NOT NULL DEFAULT '',
        customer_phone   TEXT    NOT NULL DEFAULT '',
        address_line     TEXT    NOT NULL DEFAULT '',
        address_suburb   TEXT    NOT NULL DEFAULT '',
        address_notes    TEXT    NOT NULL DEFAULT '',
        lat              REAL,
        lng              REAL,
        distance_km      REAL    NOT NULL DEFAULT 0,
        eta_minutes      INTEGER NOT NULL DEFAULT 20,
        driver_id        INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
        notes            TEXT    NOT NULL DEFAULT '',
        idempotency_key  TEXT,
        cancel_reason    TEXT    NOT NULL DEFAULT '',
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        confirmed_at     TEXT,
        ready_at         TEXT,
        dispatched_at    TEXT,
        completed_at     TEXT,
        cancelled_at     TEXT
      );
      CREATE INDEX idx_orders_user ON orders(user_id);
      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_driver ON orders(driver_id);

      CREATE TABLE order_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        item_id      INTEGER REFERENCES menu_items(id) ON DELETE SET NULL,
        name         TEXT    NOT NULL,
        unit_price   INTEGER NOT NULL,
        qty          INTEGER NOT NULL,
        line_total   INTEGER NOT NULL,
        options_json TEXT    NOT NULL DEFAULT '[]',
        notes        TEXT    NOT NULL DEFAULT ''
      );
      CREATE INDEX idx_order_items_order ON order_items(order_id);

      CREATE TABLE order_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        from_state TEXT,
        to_state   TEXT    NOT NULL,
        actor_name TEXT    NOT NULL DEFAULT 'system',
        actor_role TEXT    NOT NULL DEFAULT 'system',
        note       TEXT    NOT NULL DEFAULT '',
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_events_order ON order_events(order_id);

      CREATE TABLE promos (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        kind         TEXT    NOT NULL CHECK (kind IN ('percent','fixed','free_delivery')),
        value        INTEGER NOT NULL DEFAULT 0,
        min_subtotal INTEGER NOT NULL DEFAULT 0,
        max_uses     INTEGER NOT NULL DEFAULT 0,
        uses         INTEGER NOT NULL DEFAULT 0,
        is_active    INTEGER NOT NULL DEFAULT 1,
        expires_at   TEXT,
        description  TEXT    NOT NULL DEFAULT ''
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id   INTEGER,
        actor_name TEXT NOT NULL DEFAULT '',
        action     TEXT NOT NULL,
        entity     TEXT NOT NULL DEFAULT '',
        entity_id  TEXT NOT NULL DEFAULT '',
        meta       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
    `,
  },
  {
    id: '0002_reliability',
    sql: `
      -- Idempotent checkout: a client may retry with the same key.
      CREATE UNIQUE INDEX idx_orders_idempotency
        ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;

      -- Defensive guard: money columns can never be negative.
      CREATE TRIGGER trg_orders_money_guard
      BEFORE INSERT ON orders
      WHEN NEW.subtotal < 0 OR NEW.total < 0 OR NEW.delivery_fee < 0
      BEGIN
        SELECT RAISE(ABORT, 'money columns must be non-negative');
      END;
    `,
  },
  {
    id: '0003_ratings',
    sql: `
      CREATE TABLE ratings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id   INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment    TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
];

export default migrations;
