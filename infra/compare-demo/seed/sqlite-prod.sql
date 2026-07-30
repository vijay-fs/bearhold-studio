-- Compare-demo · SQLite prod baseline. Loaded by the sqlite-builder
-- container into infra/compare-demo/sqlite/prod.db.

PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         VARCHAR(255) NOT NULL UNIQUE,
    full_name     VARCHAR(255) NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    legacy_id     INTEGER,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
);
CREATE INDEX users_created_at_idx ON users (created_at);
CREATE INDEX users_tier_idx        ON users (tier);

CREATE TABLE categories (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      VARCHAR(80) NOT NULL,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    UNIQUE (name, parent_id)
);

CREATE TABLE products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sku          VARCHAR(64) NOT NULL UNIQUE,
    name         VARCHAR(200) NOT NULL,
    price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock        INTEGER NOT NULL DEFAULT 0,
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE orders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status    VARCHAR(16) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','shipped','cancelled','refunded')),
    total     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX orders_user_idx   ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- ---- Bulk data via recursive CTE -------------------------------------
INSERT INTO categories (name, parent_id)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20
)
SELECT 'Cat ' || n, NULL FROM seq;

INSERT INTO users (id, email, full_name, is_active, tier, legacy_id, created_at, last_login_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 1000
)
SELECT
    n,
    'user' || n || '@example.com',
    'User ' || n,
    CASE WHEN n % 20 = 0 THEN 0 ELSE 1 END,
    CASE n % 4 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' WHEN 2 THEN 'bronze' ELSE 'platinum' END,
    1000000 + n,
    datetime('now', '-' || n || ' hours'),
    CASE WHEN n % 3 = 0 THEN datetime('now', '-' || (n % 240) || ' hours') END
FROM seq;

INSERT INTO products (id, sku, name, price, stock, category_id, created_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500
)
SELECT
    n,
    'SKU-' || substr('00000' || n, -5),
    'Product ' || n,
    ROUND(10 + (n % 500) + (n * 0.13), 2),
    (n * 3) % 400,
    ((n - 1) % 20) + 1,
    datetime('now', '-' || n || ' days')
FROM seq;

INSERT INTO orders (id, user_id, status, total, placed_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
SELECT
    n,
    ((n - 1) % 1000) + 1,
    CASE n % 7
        WHEN 0 THEN 'pending' WHEN 1 THEN 'paid' WHEN 2 THEN 'paid'
        WHEN 3 THEN 'shipped' WHEN 4 THEN 'shipped'
        WHEN 5 THEN 'cancelled' ELSE 'refunded'
    END,
    ROUND((n % 250) + 5, 2),
    datetime('now', '-' || (n % 720) || ' hours')
FROM seq;

INSERT OR IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
WITH RECURSIVE seq(o, i) AS (
    SELECT 1, 0
    UNION ALL
    SELECT
        CASE WHEN i < 2 THEN o ELSE o + 1 END,
        CASE WHEN i < 2 THEN i + 1 ELSE 0 END
    FROM seq
    WHERE o <= 5000
)
SELECT o, ((o + i * 7 - 1) % 500) + 1, 1 + (i % 4),
       ROUND(5 + ((o + i * 3) % 200), 2)
FROM seq
WHERE o <= 5000;

COMMIT;
