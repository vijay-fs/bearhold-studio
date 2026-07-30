-- Reference "shop" schema for the Postgres test matrix. Covers the
-- feature shapes our diff/data-diff pipelines have to handle correctly:
--   - Serial PKs, composite PKs, self-referential FKs
--   - CHECK constraints (inline + named)
--   - JSONB, ENUM, ARRAY, TIMESTAMPTZ columns
--   - Partial + expression indexes, unique indexes
--   - Views + generated columns (14+)
--
-- Loaded once at container init. Kept intentionally version-portable —
-- anything version-specific goes in a separate file the harness applies
-- after `SHOW server_version_num` gates it.

CREATE SCHEMA IF NOT EXISTS shop;
SET search_path TO shop, public;

CREATE TYPE order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled', 'refunded');

CREATE TABLE users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX users_created_at_idx ON users (created_at DESC);
CREATE INDEX users_active_idx ON users (id) WHERE is_active;

CREATE TABLE categories (
    id        BIGSERIAL PRIMARY KEY,
    name      TEXT NOT NULL,
    parent_id BIGINT REFERENCES categories (id) ON DELETE SET NULL,
    UNIQUE (name, parent_id)
);

CREATE TABLE products (
    id           BIGSERIAL PRIMARY KEY,
    sku          TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    price        NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock        INTEGER NOT NULL DEFAULT 0,
    category_id  BIGINT NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
    tags         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category_id);
CREATE INDEX products_name_lower_idx ON products (lower(name));

CREATE TABLE orders (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status     order_status NOT NULL DEFAULT 'pending',
    total      NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    placed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);

CREATE TABLE order_items (
    order_id    BIGINT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id  BIGINT NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    quantity    INTEGER NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(10, 2) NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
);

-- Data set the harness diffs against a mutated copy.
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
    ('LAPTOP-001', 'ThinkPad X1',   1899.99, 12, 3, ARRAY['work','portable'], '{"weight_kg":1.09}'),
    ('LAPTOP-002', 'MacBook Air',   1299.00,  8, 3, ARRAY['work','apple'],    '{"weight_kg":1.24}'),
    ('BOOK-001',   'Designing Data-Intensive Apps', 45.00, 100, 4, ARRAY['tech'], '{}'),
    ('BOOK-002',   'The Pragmatic Programmer',      35.00,  50, 4, ARRAY['tech'], '{}');

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
