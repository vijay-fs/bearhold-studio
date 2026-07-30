-- Compare-demo · Postgres staging.
-- Intentional divergences from pg-prod so /compare has substance:
--
-- SCHEMA diffs (exercise Schema tab):
--   +  new table  shop.audit_log
--   +  new column products.discount_pct (nullable)
--   +  new column users.last_ip (nullable)
--   +  new index  orders_placed_at_idx
--   -  drops column users.legacy_id
--   ~  widens users.email VARCHAR(255) → VARCHAR(320)
--   ~  widens products.price NUMERIC(10,2) → NUMERIC(12,4)
--   ~  adds NOT NULL to users.tier (was nullable-defaulted in prod)
--
-- DATA diffs (exercise Tables tab):
--   users:
--     * 20 extra users (rows 1001–1020) — staging has, prod doesn't
--     * 5 users MISSING (rows 995–999) — prod has, staging doesn't
--     * ~30 users with different `full_name` ("Renamed" prefix)
--     * ~40 users with a bumped tier (bronze → silver)
--   products:
--     * 50 products with different `price` (staging is 5% higher)
--     * 10 products MISSING (rows 491–500)
--     * 5 extra products (SKU-9990x)
--   orders: identical row set, but ~200 rows have a different `status`

CREATE SCHEMA IF NOT EXISTS shop;
SET search_path TO shop, public;

CREATE TYPE order_status AS ENUM ('pending','paid','shipped','cancelled','refunded');

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         VARCHAR(320) NOT NULL UNIQUE,        -- widened
    full_name     VARCHAR(255) NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    tier          VARCHAR(16) NOT NULL DEFAULT 'bronze',
    -- legacy_id removed
    last_ip       INET,                                -- new column
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
    id             BIGSERIAL PRIMARY KEY,
    sku            VARCHAR(64) NOT NULL UNIQUE,
    name           VARCHAR(200) NOT NULL,
    price          NUMERIC(12,4) NOT NULL CHECK (price >= 0),  -- widened
    stock          INTEGER NOT NULL DEFAULT 0,
    category_id    BIGINT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    discount_pct   NUMERIC(5,2),                                -- new column
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);

CREATE TABLE orders (
    id        BIGSERIAL PRIMARY KEY,
    user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status    order_status NOT NULL DEFAULT 'pending',
    total     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx      ON orders (user_id);
CREATE INDEX orders_status_idx    ON orders (status);
CREATE INDEX orders_placed_at_idx ON orders (placed_at DESC);   -- new index

CREATE TABLE order_items (
    order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- New table: audit_log (present ONLY on staging)
CREATE TABLE audit_log (
    id        BIGSERIAL PRIMARY KEY,
    actor_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action    VARCHAR(64) NOT NULL,
    payload   JSONB,
    at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);

-- ---- Bulk data (with divergences) ------------------------------------
INSERT INTO categories (name, parent_id)
SELECT 'Cat ' || g, NULL FROM generate_series(1,20) g;

-- Users: rows 1..994 identical to prod; 995..999 skipped; 1001..1020 added.
INSERT INTO users (id, email, full_name, is_active, tier, created_at, last_login_at)
SELECT
    g,
    'user' || g || '@example.com',
    -- Rename every 33rd user so ~30 rows show as mismatched.
    CASE WHEN g % 33 = 0 THEN 'Renamed User ' || g ELSE 'User ' || g END,
    (g % 20) <> 0,
    -- Bump every 25th user's tier so ~40 rows differ on tier.
    CASE
        WHEN g % 25 = 0 THEN 'silver'
        WHEN g % 4 = 0 THEN 'gold'
        WHEN g % 4 = 1 THEN 'silver'
        WHEN g % 4 = 2 THEN 'bronze'
        ELSE 'platinum'
    END,
    now() - (g || ' hours')::interval,
    CASE WHEN g % 3 = 0 THEN now() - ((g % 240) || ' hours')::interval END
FROM generate_series(1,994) g;

-- 20 extra users only on staging.
INSERT INTO users (id, email, full_name, tier, created_at)
SELECT g, 'user' || g || '@example.com', 'Staging Extra ' || g, 'bronze', now()
FROM generate_series(1001,1020) g;

SELECT setval('users_id_seq', (SELECT max(id) FROM users));

-- Products: 1..490 present with per-row divergences; 491..500 dropped;
-- 5 new SKUs added at the tail.
INSERT INTO products (id, sku, name, price, stock, category_id, created_at, discount_pct)
SELECT
    g,
    'SKU-' || LPAD(g::text, 5, '0'),
    'Product ' || g,
    -- Bump every 10th product's price by 5% so ~50 rows show mismatched.
    ROUND(
        ((10 + (g % 500) + (g * 0.13)) * CASE WHEN g % 10 = 0 THEN 1.05 ELSE 1.0 END)::numeric,
        4
    ),
    (g * 3) % 400,
    ((g - 1) % 20) + 1,
    now() - (g || ' days')::interval,
    -- discount_pct populated on a handful of rows.
    CASE WHEN g % 50 = 0 THEN 10.00 END
FROM generate_series(1,490) g;

INSERT INTO products (id, sku, name, price, stock, category_id, created_at)
VALUES
    (99001, 'SKU-99001', 'Staging Exclusive A', 19.99, 42, 1, now()),
    (99002, 'SKU-99002', 'Staging Exclusive B', 29.99, 15, 2, now()),
    (99003, 'SKU-99003', 'Staging Exclusive C', 39.99,  8, 3, now()),
    (99004, 'SKU-99004', 'Staging Exclusive D', 49.99,  0, 4, now()),
    (99005, 'SKU-99005', 'Staging Exclusive E', 59.99, 77, 5, now());

SELECT setval('products_id_seq', (SELECT max(id) FROM products));

-- Orders: same row set as prod but ~200 rows have a different status.
-- We reuse prod's INSERT shape and mutate `status` for a modulus slice.
INSERT INTO orders (id, user_id, status, total, placed_at)
SELECT
    g,
    ((g - 1) % 994) + 1,   -- users 1..994 to avoid the 995..999 gap
    CASE
        WHEN g % 25 = 0 THEN 'refunded'::order_status
        ELSE (ARRAY['pending','paid','paid','shipped','shipped','cancelled','refunded']::order_status[])[
            1 + (g % 7)
        ]
    END,
    ROUND(((g % 250) + 5)::numeric, 2),
    now() - ((g % 720) || ' hours')::interval
FROM generate_series(1,5000) g;

SELECT setval('orders_id_seq', (SELECT max(id) FROM orders));

-- Order items: mirror prod pattern for the same order set.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o, ((o + i * 7 - 1) % 490) + 1, 1 + (i % 4),
       ROUND((5 + ((o + i * 3) % 200))::numeric, 2)
FROM generate_series(1,5000) o
CROSS JOIN generate_series(0,2) i
ON CONFLICT DO NOTHING;
