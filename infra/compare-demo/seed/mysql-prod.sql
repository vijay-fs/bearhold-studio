-- Compare-demo · MySQL prod baseline. Mirror of pg-prod adapted for
-- MySQL 8. Bulk generation via recursive CTE — no procedure needed.

CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE users (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    full_name     VARCHAR(255) NOT NULL,
    is_active     TINYINT(1) NOT NULL DEFAULT 1,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    legacy_id     BIGINT,
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
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku          VARCHAR(64) NOT NULL UNIQUE,
    name         VARCHAR(200) NOT NULL,
    price        DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    stock        INT NOT NULL DEFAULT 0,
    category_id  BIGINT UNSIGNED NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
CREATE INDEX orders_user_idx   ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
    order_id   BIGINT UNSIGNED NOT NULL,
    product_id BIGINT UNSIGNED NOT NULL,
    quantity   INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---- Bulk data via recursive CTE -------------------------------------
-- Bump the recursion cap so we can chain up to 5000 rows in one INSERT.
SET SESSION cte_max_recursion_depth = 10000;

INSERT INTO categories (name, parent_id)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 20
)
SELECT CONCAT('Cat ', n), NULL FROM seq;

INSERT INTO users (email, full_name, is_active, tier, legacy_id, created_at, last_login_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1000
)
SELECT
    CONCAT('user', n, '@example.com'),
    CONCAT('User ', n),
    IF(n % 20 = 0, 0, 1),
    ELT(1 + (n % 4), 'gold', 'silver', 'bronze', 'platinum'),
    1000000 + n,
    NOW() - INTERVAL n HOUR,
    CASE WHEN n % 3 = 0 THEN NOW() - INTERVAL (n % 240) HOUR END
FROM seq;

INSERT INTO products (sku, name, price, stock, category_id, created_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 500
)
SELECT
    CONCAT('SKU-', LPAD(n, 5, '0')),
    CONCAT('Product ', n),
    ROUND(10 + (n % 500) + (n * 0.13), 2),
    (n * 3) % 400,
    ((n - 1) % 20) + 1,
    NOW() - INTERVAL n DAY
FROM seq;

INSERT INTO orders (user_id, status, total, placed_at)
WITH RECURSIVE seq(n) AS (
    SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 5000
)
SELECT
    ((n - 1) % 1000) + 1,
    ELT(1 + (n % 7), 'pending','paid','paid','shipped','shipped','cancelled','refunded'),
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
SELECT o, ((o + i * 7 - 1) % 500) + 1, 1 + (i % 4),
       ROUND(5 + ((o + i * 3) % 200), 2)
FROM seq
WHERE o <= 5000;
