-- Reference "shop" schema for MySQL 8.0 and 8.4. Uses modern features
-- our diff pipeline must respect:
--   - CHECK constraints (enforced in 8.0.16+)
--   - Functional index (lower(name)) — 8.0.13+
--   - JSON DEFAULTs via `(JSON_ARRAY())` expression default — 8.0.13+
--   - Generated column example (last_login_month) to test invisible col diff

CREATE DATABASE IF NOT EXISTS shop;
USE shop;

CREATE TABLE users (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email             VARCHAR(255) NOT NULL UNIQUE,
    full_name         VARCHAR(255) NOT NULL,
    is_active         TINYINT(1) NOT NULL DEFAULT 1,
    created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at     DATETIME NULL,
    metadata          JSON     NULL,
    last_login_month  VARCHAR(7) GENERATED ALWAYS AS (DATE_FORMAT(last_login_at, '%Y-%m')) VIRTUAL,
    CONSTRAINT users_email_lc_ck CHECK (email = LOWER(email))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX users_created_at_idx ON users (created_at);

CREATE TABLE categories (
    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name      VARCHAR(255) NOT NULL,
    parent_id BIGINT UNSIGNED NULL,
    UNIQUE KEY categories_name_parent_uk (name, parent_id),
    CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE products (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku          VARCHAR(64) NOT NULL UNIQUE,
    name         VARCHAR(255) NOT NULL,
    price        DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
    stock        INT NOT NULL DEFAULT 0,
    category_id  BIGINT UNSIGNED NOT NULL,
    tags         JSON NULL,
    metadata     JSON NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT products_category_fk FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_name_lower_idx ON products ((LOWER(name)));

CREATE TABLE orders (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    status     ENUM('pending','paid','shipped','cancelled','refunded') NOT NULL DEFAULT 'pending',
    total      DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
    order_id    BIGINT UNSIGNED NOT NULL,
    product_id  BIGINT UNSIGNED NOT NULL,
    quantity    INT NOT NULL CHECK (quantity > 0),
    unit_price  DECIMAL(10, 2) NOT NULL,
    PRIMARY KEY (order_id, product_id),
    CONSTRAINT order_items_order_fk   FOREIGN KEY (order_id)   REFERENCES orders(id)   ON DELETE CASCADE,
    CONSTRAINT order_items_product_fk FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO users (email, full_name, metadata) VALUES
    ('alice@example.com', 'Alice Anderson', '{"tier":"gold"}'),
    ('bob@example.com',   'Bob Baker',      '{"tier":"silver"}'),
    ('carol@example.com', 'Carol Chen',     '{"tier":"gold","beta":true}'),
    ('dave@example.com',  'Dave Diaz',      '{"tier":"bronze"}');

INSERT INTO categories (name, parent_id) VALUES
    ('Electronics', NULL),
    ('Books',       NULL),
    ('Laptops',     1),
    ('Fiction',     2);

INSERT INTO products (sku, name, price, stock, category_id, tags, metadata) VALUES
    ('LAPTOP-001', 'ThinkPad X1',   1899.99, 12, 3, '["work","portable"]', '{"weight_kg":1.09}'),
    ('LAPTOP-002', 'MacBook Air',   1299.00,  8, 3, '["work","apple"]',    '{"weight_kg":1.24}'),
    ('BOOK-001',   'Designing Data-Intensive Apps', 45.00, 100, 4, '["tech"]', NULL),
    ('BOOK-002',   'The Pragmatic Programmer',      35.00,  50, 4, '["tech"]', NULL);

INSERT INTO orders (user_id, status, total) VALUES
    (1, 'paid',    1899.99),
    (1, 'pending',   45.00),
    (2, 'shipped', 1344.00),
    (3, 'paid',      80.00);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
    (1, 1, 1, 1899.99),
    (2, 3, 1,   45.00),
    (3, 2, 1, 1299.00),
    (3, 3, 1,   45.00),
    (4, 3, 1,   45.00),
    (4, 4, 1,   35.00);
