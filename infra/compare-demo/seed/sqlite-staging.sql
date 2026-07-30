-- Compare-demo · SQLite staging. Same divergences as the PG/MySQL
-- staging seeds, adapted to SQLite:
--
-- SCHEMA: SQLite's type system is affinity-based, so widening a
-- VARCHAR isn't observable through diff — instead we exercise the
-- structural divergences that DO show up: new table (audit_log),
-- new column (products.discount_pct), new column (users.last_ip),
-- new index (orders_placed_at_idx), dropped column (users.legacy_id).
--
-- DATA: same 20 extras / 5 missing / 30 renamed / 40 tier bumps
-- pattern as the other engines.

PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;

CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         VARCHAR(320) NOT NULL UNIQUE,           -- affinity is TEXT anyway
    full_name     VARCHAR(255) NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    -- legacy_id removed
    last_ip       TEXT,                                   -- new column
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
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sku            VARCHAR(64) NOT NULL UNIQUE,
    name           VARCHAR(200) NOT NULL,
    price          NUMERIC(12,4) NOT NULL CHECK (price >= 0),
    stock          INTEGER NOT NULL DEFAULT 0,
    category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    discount_pct   NUMERIC(5,2),                          -- new column
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
CREATE INDEX orders_user_idx      ON orders (user_id);
CREATE INDEX orders_status_idx    ON orders (status);
CREATE INDEX orders_placed_at_idx ON orders (placed_at);   -- new index

CREATE TABLE order_items (
    order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- New table (present ONLY on staging)
CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action    VARCHAR(64) NOT NULL,
    payload   TEXT,
    at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);

INSERT INTO categories (name, parent_id)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20
)
SELECT 'Cat ' || n, NULL FROM seq;

-- Users 1..994 with renames + tier bumps
INSERT INTO users (id, email, full_name, is_active, tier, created_at, last_login_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 994
)
SELECT
    n,
    'user' || n || '@example.com',
    CASE WHEN n % 33 = 0 THEN 'Renamed User ' || n ELSE 'User ' || n END,
    CASE WHEN n % 20 = 0 THEN 0 ELSE 1 END,
    CASE
        WHEN n % 25 = 0 THEN 'silver'
        WHEN n % 4 = 0 THEN 'gold' WHEN n % 4 = 1 THEN 'silver'
        WHEN n % 4 = 2 THEN 'bronze' ELSE 'platinum'
    END,
    datetime('now', '-' || n || ' hours'),
    CASE WHEN n % 3 = 0 THEN datetime('now', '-' || (n % 240) || ' hours') END
FROM seq;

-- 20 staging-only users
INSERT INTO users (id, email, full_name, tier, created_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1001 UNION ALL SELECT n + 1 FROM seq WHERE n < 1020
)
SELECT n, 'user' || n || '@example.com', 'Staging Extra ' || n, 'bronze', datetime('now')
FROM seq;

-- Products 1..490 with 50 bumped by 5%
INSERT INTO products (id, sku, name, price, stock, category_id, created_at, discount_pct)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 490
)
SELECT
    n,
    'SKU-' || substr('00000' || n, -5),
    'Product ' || n,
    ROUND((10 + (n % 500) + (n * 0.13)) * CASE WHEN n % 10 = 0 THEN 1.05 ELSE 1.0 END, 4),
    (n * 3) % 400,
    ((n - 1) % 20) + 1,
    datetime('now', '-' || n || ' days'),
    CASE WHEN n % 50 = 0 THEN 10.00 END
FROM seq;

-- 5 staging-only products
INSERT INTO products (id, sku, name, price, stock, category_id, created_at) VALUES
    (99001, 'SKU-99001', 'Staging Exclusive A', 19.99, 42, 1, datetime('now')),
    (99002, 'SKU-99002', 'Staging Exclusive B', 29.99, 15, 2, datetime('now')),
    (99003, 'SKU-99003', 'Staging Exclusive C', 39.99,  8, 3, datetime('now')),
    (99004, 'SKU-99004', 'Staging Exclusive D', 49.99,  0, 4, datetime('now')),
    (99005, 'SKU-99005', 'Staging Exclusive E', 59.99, 77, 5, datetime('now'));

-- Orders: 5000 rows, ~200 with a `refunded` override
INSERT INTO orders (id, user_id, status, total, placed_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
SELECT
    n,
    ((n - 1) % 994) + 1,
    CASE
        WHEN n % 25 = 0 THEN 'refunded'
        ELSE CASE n % 7
            WHEN 0 THEN 'pending' WHEN 1 THEN 'paid' WHEN 2 THEN 'paid'
            WHEN 3 THEN 'shipped' WHEN 4 THEN 'shipped'
            WHEN 5 THEN 'cancelled' ELSE 'refunded'
        END
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
SELECT o, ((o + i * 7 - 1) % 490) + 1, 1 + (i % 4),
       ROUND(5 + ((o + i * 3) % 200), 2)
FROM seq
WHERE o <= 5000;

COMMIT;
