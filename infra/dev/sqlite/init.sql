-- Sample SQLite schema mirroring the Postgres/MySQL shop schema. Run with:
--   sqlite3 shop.sqlite < init.sql

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  full_name     TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX users_created_at_idx ON users (created_at);

CREATE TABLE categories (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories (id) ON DELETE SET NULL,
  UNIQUE (name, parent_id)
);

CREATE TABLE products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sku         TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  price       NUMERIC NOT NULL CHECK (price >= 0),
  stock       INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  metadata    TEXT    NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE orders (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status    TEXT    NOT NULL CHECK (status IN ('pending','paid','shipped','cancelled')),
  total     NUMERIC NOT NULL DEFAULT 0,
  placed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX orders_user_idx   ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
  order_id   INTEGER NOT NULL REFERENCES orders (id)   ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, product_id)
);

-- Seed ----------------------------------------------------------------------

INSERT INTO categories (id, name, parent_id) VALUES
  (1, 'Electronics', NULL),
  (2, 'Audio',       1),
  (3, 'Wearables',   1),
  (4, 'Home',        NULL),
  (5, 'Kitchen',     4),
  (6, 'Office',      NULL);

INSERT INTO users (email, full_name, last_login_at) VALUES
  ('ada@example.com',      'Ada Lovelace',      datetime('now','-1 day')),
  ('grace@example.com',    'Grace Hopper',      datetime('now','-3 hours')),
  ('linus@example.com',    'Linus Torvalds',    datetime('now','-7 days')),
  ('alan@example.com',     'Alan Turing',       datetime('now','-12 hours')),
  ('margaret@example.com', 'Margaret Hamilton', NULL);

INSERT INTO products (sku, name, price, stock, category_id, metadata) VALUES
  ('AUDIO-001', 'Wireless Headphones', 199.00, 42, 2, '{"color":"black","wireless":true}'),
  ('AUDIO-002', 'Studio Monitor Pair', 349.50, 12, 2, '{"impedance":"6ohm"}'),
  ('WEAR-001',  'Smart Watch v3',      299.99, 80, 3, '{"battery_hours":36}'),
  ('KITCH-01',  'Espresso Machine',    549.00,  9, 5, '{"bar_pressure":15}'),
  ('OFFICE-01', 'Standing Desk',       620.00, 18, 6, '{"height_range_cm":[70,120]}');

INSERT INTO orders (user_id, status, total, placed_at) VALUES
  (1, 'paid',      199.00, datetime('now','-6 days')),
  (2, 'shipped',   549.00, datetime('now','-4 days')),
  (3, 'paid',      948.99, datetime('now','-2 days')),
  (4, 'pending',   299.99, datetime('now','-1 day')),
  (1, 'cancelled', 199.00, datetime('now','-10 days'));

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 199.00),
  (2, 4, 1, 549.00),
  (3, 1, 1, 199.00),
  (3, 5, 1, 620.00),
  (3, 3, 1, 129.99),
  (4, 3, 1, 299.99),
  (5, 1, 1, 199.00);

INSERT INTO reviews (user_id, product_id, rating, body) VALUES
  (1, 1, 5, 'Best headphones I have owned.'),
  (2, 4, 4, 'Great espresso, slightly noisy pump.'),
  (3, 5, 5, 'Build quality is excellent.'),
  (4, 3, 3, 'Battery life is shorter than advertised.');
