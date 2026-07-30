-- Compare-demo · Postgres prod baseline.
-- Bulk data: 1000 users, 500 products, 5000 orders, ~15000 order_items.
-- Everything under schema `shop`.

CREATE SCHEMA IF NOT EXISTS shop;
SET search_path TO shop, public;

CREATE TYPE order_status AS ENUM ('pending','paid','shipped','cancelled','refunded');

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    full_name     VARCHAR(255) NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    legacy_id     BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX users_tier_idx        ON users (tier);

CREATE TABLE categories (
    id        BIGSERIAL PRIMARY KEY,
    name      VARCHAR(80) NOT NULL,
    parent_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
    UNIQUE (name, parent_id)
);

CREATE TABLE products (
    id           BIGSERIAL PRIMARY KEY,
    sku          VARCHAR(64) NOT NULL UNIQUE,
    name         VARCHAR(200) NOT NULL,
    price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    stock        INTEGER NOT NULL DEFAULT 0,
    category_id  BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE orders (
    id        BIGSERIAL PRIMARY KEY,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status    order_status NOT NULL DEFAULT 'pending',
    total     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx   ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
    order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- ---- Bulk data --------------------------------------------------------
-- Categories: 20 seed rows so products can spread across them.
INSERT INTO categories (name, parent_id)
SELECT 'Cat ' || g, NULL
FROM generate_series(1,20) g;

-- Users: 1000 rows. Deterministic values so prod ↔ staging comparison
-- surfaces intentional divergences, not random noise.
INSERT INTO users (email, full_name, is_active, tier, legacy_id, created_at, last_login_at)
SELECT
    'user' || g || '@example.com',
    'User ' || g,
    (g % 20) <> 0,                                            -- ~5% inactive
    CASE g % 4 WHEN 0 THEN 'gold' WHEN 1 THEN 'silver' WHEN 2 THEN 'bronze' ELSE 'platinum' END,
    1000000 + g,                                              -- legacy_id present on prod
    now() - (g || ' hours')::interval,
    CASE WHEN g % 3 = 0 THEN now() - ((g % 240) || ' hours')::interval END
FROM generate_series(1,1000) g;

-- Products: 500 rows. Deterministic price so we know which will diverge.
INSERT INTO products (sku, name, price, stock, category_id, created_at)
SELECT
    'SKU-' || LPAD(g::text, 5, '0'),
    'Product ' || g,
    ROUND((10 + (g % 500) + (g * 0.13))::numeric, 2),
    (g * 3) % 400,
    ((g - 1) % 20) + 1,
    now() - (g || ' days')::interval
FROM generate_series(1,500) g;

-- Orders: 5000 rows referencing users 1..1000 in a stable round-robin.
INSERT INTO orders (user_id, status, total, placed_at)
SELECT
    ((g - 1) % 1000) + 1,
    (ARRAY['pending','paid','paid','shipped','shipped','cancelled','refunded']::order_status[])[
        1 + (g % 7)
    ],
    ROUND(((g % 250) + 5)::numeric, 2),
    now() - ((g % 720) || ' hours')::interval
FROM generate_series(1,5000) g;

-- Order items: 3 items per order on average. Products round-robin.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o, ((o + i * 7 - 1) % 500) + 1, 1 + (i % 4),
       ROUND((5 + ((o + i * 3) % 200))::numeric, 2)
FROM generate_series(1,5000) o
CROSS JOIN generate_series(0,2) i
ON CONFLICT DO NOTHING;
