-- Parallel sample schema for the MySQL Phase 2 driver. Mirrors the Postgres
-- shop schema so users can compare ER diagrams across engines.

USE shop;

CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  full_name     VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL
);
CREATE INDEX users_created_at_idx ON users (created_at);

CREATE TABLE categories (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name      VARCHAR(255) NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  CONSTRAINT fk_categories_parent
    FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE SET NULL,
  UNIQUE KEY uk_categories_name_parent (name, parent_id)
);

CREATE TABLE products (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sku         VARCHAR(64) NOT NULL UNIQUE,
  name        VARCHAR(255) NOT NULL,
  price       DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
  stock       INT NOT NULL DEFAULT 0,
  category_id BIGINT UNSIGNED NOT NULL,
  metadata    JSON NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT,
  INDEX products_category_idx (category_id)
);

CREATE TABLE orders (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  status     ENUM('pending','paid','shipped','cancelled') NOT NULL,
  total      DECIMAL(10, 2) NOT NULL DEFAULT 0,
  placed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  INDEX orders_user_idx (user_id),
  INDEX orders_status_idx (status)
);

CREATE TABLE order_items (
  order_id    BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  quantity    INT NOT NULL CHECK (quantity > 0),
  unit_price  DECIMAL(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_oi_order
    FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_oi_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
);

CREATE TABLE reviews (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  rating     TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body       TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reviews_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  UNIQUE KEY uk_reviews_user_product (user_id, product_id)
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
  ('ada@example.com',      'Ada Lovelace',      NOW() - INTERVAL 1 DAY),
  ('grace@example.com',    'Grace Hopper',      NOW() - INTERVAL 3 HOUR),
  ('linus@example.com',    'Linus Torvalds',    NOW() - INTERVAL 7 DAY),
  ('alan@example.com',     'Alan Turing',       NOW() - INTERVAL 12 HOUR),
  ('margaret@example.com', 'Margaret Hamilton', NULL);

INSERT INTO products (sku, name, price, stock, category_id, metadata) VALUES
  ('AUDIO-001', 'Wireless Headphones', 199.00, 42, 2, JSON_OBJECT('color', 'black', 'wireless', true)),
  ('AUDIO-002', 'Studio Monitor Pair', 349.50, 12, 2, JSON_OBJECT('impedance', '6ohm')),
  ('WEAR-001',  'Smart Watch v3',      299.99, 80, 3, JSON_OBJECT('battery_hours', 36)),
  ('KITCH-01',  'Espresso Machine',    549.00,  9, 5, JSON_OBJECT('bar_pressure', 15)),
  ('OFFICE-01', 'Standing Desk',       620.00, 18, 6, JSON_OBJECT('height_range_cm', JSON_ARRAY(70, 120)));

INSERT INTO orders (user_id, status, total, placed_at) VALUES
  (1, 'paid',      199.00, NOW() - INTERVAL 6  DAY),
  (2, 'shipped',   549.00, NOW() - INTERVAL 4  DAY),
  (3, 'paid',      948.99, NOW() - INTERVAL 2  DAY),
  (4, 'pending',   299.99, NOW() - INTERVAL 1  DAY),
  (1, 'cancelled', 199.00, NOW() - INTERVAL 10 DAY);

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

-- Ensure the app user can use mysql_native_password (sqlx-friendly default
-- when not using TLS).
ALTER USER 'dbstudio'@'%' IDENTIFIED WITH mysql_native_password BY 'dbstudio_dev';
FLUSH PRIVILEGES;
