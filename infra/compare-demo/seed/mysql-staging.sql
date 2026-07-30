-- Compare-demo · MySQL staging. Same divergence catalogue as pg-staging
-- but expressed with MySQL 8 primitives.
--
-- SCHEMA diffs:
--   +  new table  audit_log
--   +  new column products.discount_pct DECIMAL(5,2) NULL
--   +  new column users.last_ip VARBINARY(16) NULL      (MySQL has no INET)
--   +  new index  orders_placed_at_idx
--   -  drops column users.legacy_id
--   ~  widens users.email VARCHAR(255) → VARCHAR(320)
--   ~  widens products.price DECIMAL(10,2) → DECIMAL(12,4)
--
-- DATA diffs:
--   users     — 20 extra staging rows, 5 missing prod rows,
--               ~30 renamed, ~40 with a bumped tier
--   products  — 50 with a 5% higher price, 10 missing, 5 extras
--   orders    — same row set, ~200 with a different status

CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE users (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(320) NOT NULL UNIQUE,           -- widened
    full_name     VARCHAR(255) NOT NULL,
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    -- legacy_id removed
    last_ip       VARBINARY(16) NULL,                     -- new column
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX users_created_at_idx ON users (created_at);
CREATE INDEX users_tier_idx        ON users (tier);

CREATE TABLE categories (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name      VARCHAR(80) NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    UNIQUE KEY categories_name_parent_uk (name, parent_id),
    CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku            VARCHAR(64) NOT NULL UNIQUE,
    name           VARCHAR(200) NOT NULL,
    price          DECIMAL(12, 4) NOT NULL CHECK (price >= 0),   -- widened
    stock          INT NOT NULL DEFAULT 0,
    category_id    BIGINT UNSIGNED NOT NULL,
    discount_pct   DECIMAL(5, 2) NULL,                            -- new column
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_category_fk FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE orders (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id   BIGINT UNSIGNED NOT NULL,
    status    ENUM('pending','paid','shipped','cancelled','refunded') NOT NULL DEFAULT 'pending',
    total     DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX orders_user_idx      ON orders (user_id);
CREATE INDEX orders_status_idx    ON orders (status);
CREATE INDEX orders_placed_at_idx ON orders (placed_at);         -- new index

CREATE TABLE order_items (
    order_id   BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity   INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- New table: audit_log (present ONLY on staging)
CREATE TABLE audit_log (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    actor_id  BIGINT UNSIGNED NULL,
    action    VARCHAR(64) NOT NULL,
    payload   JSON NULL,
    at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT audit_log_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);

SET SESSION cte_max_recursion_depth = 10000;

INSERT INTO categories (name, parent_id)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 20
)
SELECT CONCAT('Cat ', n), NULL FROM seq;

-- Users 1..994 (mirror of prod with renames + tier bumps sprinkled in)
INSERT INTO users (id, email, full_name, is_active, tier, created_at, last_login_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 994
)
SELECT
    n,
    CONCAT('user', n, '@example.com'),
    IF(n % 33 = 0, CONCAT('Renamed User ', n), CONCAT('User ', n)),
    IF(n % 20 = 0, 0, 1),
    CASE
        WHEN n % 25 = 0 THEN 'silver'
        ELSE ELT(1 + (n % 4), 'gold', 'silver', 'bronze', 'platinum')
    END,
    NOW() - INTERVAL n HOUR,
    CASE WHEN n % 3 = 0 THEN NOW() - INTERVAL (n % 240) HOUR END
FROM seq;

-- 20 staging-only users (id 1001..1020)
INSERT INTO users (id, email, full_name, tier, created_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1001 UNION ALL SELECT n+1 FROM seq WHERE n < 1020
)
SELECT n, CONCAT('user', n, '@example.com'), CONCAT('Staging Extra ', n), 'bronze', NOW()
FROM seq;

-- Products 1..490 with 50 having a 5% price bump; discount_pct sparsely populated
INSERT INTO products (id, sku, name, price, stock, category_id, created_at, discount_pct)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 490
)
SELECT
    n,
    CONCAT('SKU-', LPAD(n, 5, '0')),
    CONCAT('Product ', n),
    ROUND((10 + (n % 500) + (n * 0.13)) * IF(n % 10 = 0, 1.05, 1.0), 4),
    (n * 3) % 400,
    ((n - 1) % 20) + 1,
    NOW() - INTERVAL n DAY,
    CASE WHEN n % 50 = 0 THEN 10.00 END
FROM seq;

INSERT INTO products (id, sku, name, price, stock, category_id, created_at) VALUES
    (99001, 'SKU-99001', 'Staging Exclusive A', 19.9900, 42, 1, NOW()),
    (99002, 'SKU-99002', 'Staging Exclusive B', 29.9900, 15, 2, NOW()),
    (99003, 'SKU-99003', 'Staging Exclusive C', 39.9900,  8, 3, NOW()),
    (99004, 'SKU-99004', 'Staging Exclusive D', 49.9900,  0, 4, NOW()),
    (99005, 'SKU-99005', 'Staging Exclusive E', 59.9900, 77, 5, NOW());

-- Orders: 5000 rows referencing users 1..994 (avoid the 995..999 gap);
-- every 25th row has a `refunded` status instead of the prod default.
INSERT INTO orders (id, user_id, status, total, placed_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 5000
)
SELECT
    n,
    ((n - 1) % 994) + 1,
    IF(n % 25 = 0,
       'refunded',
       ELT(1 + (n % 7), 'pending','paid','paid','shipped','shipped','cancelled','refunded')),
    ROUND((n % 250) + 5, 2),
    NOW() - INTERVAL (n % 720) HOUR
FROM seq;

INSERT IGNORE INTO order_items (order_id, product_id, quantity, unit_price)
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
