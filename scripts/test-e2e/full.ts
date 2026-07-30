// FULL end-to-end harness. Unlike index.ts (which only lints fixture
// SQL with node clients), this one drives the PRODUCTION code paths:
//
//   - Rust drivers via the `testkit` binary (services/testkit):
//     introspection, statement splitting, session pinning, apply_batch.
//   - The real TS generators: diffSchemas (schema migration flow) and
//     diffData + buildSyncStatements (data sync flow).
//
// Per SQL target:
//   Phase A — driver battery: sessions, transactions, temp tables,
//             PREPARE/EXECUTE, CTEs/window fns, multi-statement, error
//             surfacing, DDL-then-reselect (cached plan), apply_batch.
//   Phase B — schema flow: seed src+tgt DBs identically, diverge tgt,
//             introspect both (Rust), diffSchemas (TS), apply to src
//             (Rust apply_batch), re-introspect, re-diff → expect zero.
//   Phase C — data flow: diverge rows in tgt, SELECT both sides (Rust),
//             diffData + buildSyncStatements (TS), apply, re-diff →
//             expect zero.
//
// Usage:  tsx scripts/test-e2e/full.ts [targetId ...]
// Output: test-results/FULL-REPORT.md + full-report.json

import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { diffSchemas, type DiffChange } from '../../apps/web/lib/schemaDiff';
import { diffData } from '../../apps/web/lib/dataDiff';
import { buildSyncStatements } from '../../apps/web/lib/dataDiffSql';
import { parseVersionString, type EngineVersion } from '../../apps/web/lib/engineVersion';
import type { DatabaseEngine } from '../../apps/web/lib/types';

// --- Targets -------------------------------------------------------------

interface SqlTarget {
  id: string;
  engine: DatabaseEngine;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  /** Admin database used for CREATE/DROP DATABASE. */
  adminDb?: string;
  /** SQLite only: directory for the db files. */
  dir?: string;
}

const DOCKER_TARGETS: SqlTarget[] = [
  { id: 'pg12', engine: 'postgres', host: '127.0.0.1', port: 5412, user: 'dbstudio', password: 'dbstudio_test', adminDb: 'shop' },
  { id: 'pg16', engine: 'postgres', host: '127.0.0.1', port: 5416, user: 'dbstudio', password: 'dbstudio_test', adminDb: 'shop' },
  { id: 'mysql57', engine: 'mysql', host: '127.0.0.1', port: 3357, user: 'root', password: 'dbstudio_root', adminDb: 'shop' },
  { id: 'mysql80', engine: 'mysql', host: '127.0.0.1', port: 3380, user: 'root', password: 'dbstudio_root', adminDb: 'shop' },
  { id: 'sqlite', engine: 'sqlite', dir: tmpdir() },
];

const argFilter = process.argv.slice(2);
const TARGETS = argFilter.length
  ? DOCKER_TARGETS.filter((t) => argFilter.includes(t.id))
  : DOCKER_TARGETS;

// --- testkit bridge ------------------------------------------------------

const TESTKIT = resolve(__dirname, '../../target/debug/testkit');

interface Profile {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  auth: Record<string, unknown>;
  tls: string;
  options: Record<string, string>;
  file_path?: string;
}

let profileCounter = 0;
function profileFor(t: SqlTarget, database: string): Profile {
  // Fresh UUID per (target, database) so the driver's pool cache in a
  // single testkit invocation never crosses databases. testkit is one
  // process per request anyway; the uuid mainly keeps things honest.
  profileCounter += 1;
  const hex = profileCounter.toString(16).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${hex}`,
    name: `${t.id}/${database}`,
    engine: t.engine,
    host: t.host ?? '',
    port: t.port ?? 0,
    database: t.engine === 'sqlite' ? '' : database,
    auth:
      t.engine === 'sqlite'
        ? { kind: 'none' }
        : { kind: 'password', username: t.user, password_ref: t.password },
    tls: 'prefer',
    options: {},
    ...(t.engine === 'sqlite' ? { file_path: database } : {}),
  };
}

type KitResult =
  | { ok: unknown }
  | { err: { code: string; message: string } };

function kit(op: string, profile: Profile, extra: Record<string, unknown> = {}): KitResult {
  const request = JSON.stringify({ op, profile, ...extra });
  try {
    const out = execFileSync(TESTKIT, [], { input: request, encoding: 'utf8', timeout: 60_000 });
    return JSON.parse(out.trim().split('\n').pop() ?? '{}') as KitResult;
  } catch (e) {
    const err = e as { stdout?: string; message: string };
    // Non-zero exit still prints the JSON error envelope on stdout.
    const line = err.stdout?.trim().split('\n').pop();
    if (line) {
      try {
        return JSON.parse(line) as KitResult;
      } catch {
        /* fall through */
      }
    }
    return { err: { code: 'spawn', message: err.message } };
  }
}

function kitOk(op: string, profile: Profile, extra: Record<string, unknown> = {}): unknown {
  const r = kit(op, profile, extra);
  if ('err' in r) throw new Error(`${op} failed: ${r.err.code} — ${r.err.message}`);
  return r.ok;
}

// --- Result collection ---------------------------------------------------

interface CaseResult {
  target: string;
  phase: 'driver' | 'schema-diff' | 'data-diff';
  case: string;
  outcome: 'pass' | 'fail' | 'known-issue' | 'skip';
  detail?: string;
}

const results: CaseResult[] = [];

function record(target: string, phase: CaseResult['phase'], name: string, outcome: CaseResult['outcome'], detail?: string) {
  results.push({ target, phase, case: name, outcome, detail });
  const mark = outcome === 'pass' ? '✔' : outcome === 'skip' ? '·' : outcome === 'known-issue' ? '~' : '✗';
  console.log(`  ${mark} [${phase}] ${name}${detail && outcome !== 'pass' ? ` — ${detail.slice(0, 140)}` : ''}`);
}

// --- Fixtures ------------------------------------------------------------

function fixtureSql(engine: DatabaseEngine): string[] {
  if (engine === 'mysql') {
    return [
      `CREATE TABLE customers (
        id BIGINT NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        status ENUM('ACTIVE','SUSPENDED','DELETED') NOT NULL DEFAULT 'ACTIVE',
        tier VARCHAR(16) DEFAULT 'free',
        balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        meta JSON,
        note TEXT,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        PRIMARY KEY (id),
        UNIQUE KEY uq_customers_email (email)
      )`,
      `CREATE TABLE orders (
        id BIGINT NOT NULL AUTO_INCREMENT,
        customer_id BIGINT NOT NULL,
        status ENUM('NEW','PAID','SHIPPED','CANCELLED') NOT NULL DEFAULT 'NEW',
        total DECIMAL(12,2) NOT NULL,
        placed_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        KEY idx_orders_customer (customer_id),
        KEY idx_orders_status (status),
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
      )`,
      `INSERT INTO customers (email, full_name, status, tier, balance, meta, note, updated_at) VALUES
        ('alice@example.com', 'Alice Ahn', 'ACTIVE', 'pro', 120.50, '{"tags":["vip"]}', 'first customer', '2026-01-05 10:00:00'),
        ('bob@example.com', 'Bob O''Brien', 'ACTIVE', 'free', 0.00, NULL, NULL, NULL),
        ('carol@example.com', 'Carol Строганова', 'SUSPENDED', 'free', -5.25, '{"flags":{"beta":true}}', 'unicode + negative balance', '2026-02-10 09:30:00'),
        ('dan@example.com', 'Dan Ó Sé', 'ACTIVE', 'enterprise', 9999999.99, '{}', 'quote '' inside', '2026-03-01 00:00:00')`,
      `INSERT INTO orders (customer_id, status, total, placed_at) VALUES
        (1, 'PAID', 99.99, '2026-04-01 12:00:00'),
        (1, 'NEW', 10.00, '2026-04-02 13:00:00'),
        (3, 'CANCELLED', 0.01, '2026-04-03 14:00:00')`,
    ];
  }
  if (engine === 'postgres') {
    return [
      `CREATE TABLE customers (
        id BIGSERIAL,
        email VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
        tier VARCHAR(16) DEFAULT 'free',
        balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
        meta JSONB,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMP,
        PRIMARY KEY (id)
      )`,
      `CREATE UNIQUE INDEX uq_customers_email ON customers (email)`,
      `CREATE TABLE orders (
        id BIGSERIAL,
        customer_id BIGINT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'NEW',
        total NUMERIC(12,2) NOT NULL,
        placed_at TIMESTAMP NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
      )`,
      `CREATE INDEX idx_orders_customer ON orders (customer_id)`,
      `CREATE INDEX idx_orders_status ON orders (status)`,
      `INSERT INTO customers (email, full_name, status, tier, balance, meta, note, updated_at) VALUES
        ('alice@example.com', 'Alice Ahn', 'ACTIVE', 'pro', 120.50, '{"tags":["vip"]}', 'first customer', '2026-01-05 10:00:00'),
        ('bob@example.com', 'Bob O''Brien', 'ACTIVE', 'free', 0.00, NULL, NULL, NULL),
        ('carol@example.com', 'Carol Строганова', 'SUSPENDED', 'free', -5.25, '{"flags":{"beta":true}}', 'unicode + negative balance', '2026-02-10 09:30:00'),
        ('dan@example.com', 'Dan Ó Sé', 'ACTIVE', 'enterprise', 9999999.99, '{}', 'quote '' inside', '2026-03-01 00:00:00')`,
      `INSERT INTO orders (customer_id, status, total, placed_at) VALUES
        (1, 'PAID', 99.99, '2026-04-01 12:00:00'),
        (1, 'NEW', 10.00, '2026-04-02 13:00:00'),
        (3, 'CANCELLED', 0.01, '2026-04-03 14:00:00')`,
    ];
  }
  // sqlite
  return [
    `CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      full_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      tier TEXT DEFAULT 'free',
      balance REAL NOT NULL DEFAULT 0,
      meta TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    )`,
    `CREATE UNIQUE INDEX uq_customers_email ON customers (email)`,
    `CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'NEW',
      total REAL NOT NULL,
      placed_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers (id)
    )`,
    `CREATE INDEX idx_orders_customer ON orders (customer_id)`,
    `CREATE INDEX idx_orders_status ON orders (status)`,
    `INSERT INTO customers (email, full_name, status, tier, balance, meta, note, updated_at) VALUES
      ('alice@example.com', 'Alice Ahn', 'ACTIVE', 'pro', 120.50, '{"tags":["vip"]}', 'first customer', '2026-01-05 10:00:00'),
      ('bob@example.com', 'Bob O''Brien', 'ACTIVE', 'free', 0, NULL, NULL, NULL),
      ('carol@example.com', 'Carol Строганова', 'SUSPENDED', 'free', -5.25, '{"flags":{"beta":true}}', 'unicode + negative balance', '2026-02-10 09:30:00'),
      ('dan@example.com', 'Dan Ó Sé', 'ACTIVE', 'enterprise', 9999999.99, '{}', 'quote '' inside', '2026-03-01 00:00:00')`,
    `INSERT INTO orders (customer_id, status, total, placed_at) VALUES
      (1, 'PAID', 99.99, '2026-04-01 12:00:00'),
      (1, 'NEW', 10.00, '2026-04-02 13:00:00'),
      (3, 'CANCELLED', 0.01, '2026-04-03 14:00:00')`,
  ];
}

// --- DB lifecycle ---------------------------------------------------------

/** Create a fresh database (or sqlite file) and seed it. Returns the
 *  profile pointing at it. */
function freshDb(t: SqlTarget, name: string): Profile {
  if (t.engine === 'sqlite') {
    const path = resolve(t.dir!, `dbstudio-e2e-${name}.db`);
    rmSync(path, { force: true });
    rmSync(path + '-wal', { force: true });
    rmSync(path + '-shm', { force: true });
    // The driver intentionally does NOT create missing files (a typo'd
    // path must error, not silently make an empty db). A zero-byte file
    // is a valid empty SQLite database.
    writeFileSync(path, '');
    const profile = profileFor(t, path);
    for (const stmt of fixtureSql(t.engine)) kitOk('query', profile, { sql: stmt });
    return profile;
  }
  const admin = profileFor(t, t.adminDb!);
  kitOk('query', admin, { sql: `DROP DATABASE IF EXISTS ${name}` });
  kitOk('query', admin, { sql: `CREATE DATABASE ${name}` });
  const profile = profileFor(t, name);
  for (const stmt of fixtureSql(t.engine)) kitOk('query', profile, { sql: stmt });
  return profile;
}

function dropDb(t: SqlTarget, name: string) {
  if (t.engine === 'sqlite') return;
  const admin = profileFor(t, t.adminDb!);
  try {
    kitOk('query', admin, { sql: `DROP DATABASE IF EXISTS ${name}` });
  } catch {
    /* best effort */
  }
}

// --- Small helpers ---------------------------------------------------------

interface KitQueryResult {
  columns: Array<{ name: string; data_type: string }>;
  rows: unknown[][];
  rows_affected: number | null;
  truncated: boolean;
}

function q(profile: Profile, sql: string): KitQueryResult {
  return kitOk('query', profile, { sql }) as KitQueryResult;
}

function scalar(profile: Profile, sql: string): unknown {
  const r = q(profile, sql);
  return r.rows[0]?.[0];
}

interface KitSchema {
  schemas: Array<{
    name: string;
    tables: Array<Record<string, unknown> & { schema: string; name: string; columns: Array<{ name: string; data_type: string }> }>;
    views: unknown[];
  }>;
}

/** Introspect and normalize the schema label on every table so two
 *  different physical databases diff as if they had the same name —
 *  which is the real-world compare setup (same db name, two servers). */
function schemaOf(profile: Profile, normalizeTo: string): KitSchema {
  const s = kitOk('schema', profile) as KitSchema;
  for (const ns of s.schemas) {
    const physical = ns.name;
    ns.name = normalizeTo;
    for (const t of ns.tables) {
      t.schema = normalizeTo;
      const fks = (t as { foreign_keys?: Array<{ references_schema: string }> }).foreign_keys ?? [];
      for (const fk of fks) fk.references_schema = normalizeTo;
    }
    const views = (ns as { views?: Array<{ schema: string; definition?: string | null }> }).views ?? [];
    for (const v of views) {
      v.schema = normalizeTo;
      // MySQL's VIEW_DEFINITION db-qualifies every table reference
      // with the physical database name. Rewrite to the common label —
      // in real usage both sides share the database name, so the
      // canonical forms match; the harness's e2e_src/e2e_tgt split is
      // the artifact being corrected here.
      if (v.definition) {
        v.definition = v.definition
          .split('`' + physical + '`.').join('`' + normalizeTo + '`.')
          .split(physical + '.').join(normalizeTo + '.');
      }
    }
  }
  return s;
}

function serverVersion(t: SqlTarget, profile: Profile): EngineVersion {
  if (t.engine === 'sqlite') return parseVersionString('sqlite', String(scalar(profile, 'SELECT sqlite_version()')));
  if (t.engine === 'postgres') return parseVersionString('postgres', String(scalar(profile, 'SHOW server_version')));
  return parseVersionString('mysql', String(scalar(profile, 'SELECT VERSION()')));
}

// === Phase A: driver battery ================================================

function phaseDriver(t: SqlTarget) {
  const dbName = 'e2e_drv';
  let p: Profile;
  try {
    p = freshDb(t, dbName);
  } catch (e) {
    record(t.id, 'driver', 'setup', 'fail', (e as Error).message);
    return;
  }

  const check = (name: string, fn: () => void) => {
    try {
      fn();
      record(t.id, 'driver', name, 'pass');
    } catch (e) {
      record(t.id, 'driver', name, 'fail', (e as Error).message);
    }
  };

  // A1 — transaction commit spanning statements
  check('txn-commit-spans-statements', () => {
    const begin = t.engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
    q(p, `${begin};\nUPDATE customers SET tier = 'gold' WHERE id = 1;\nCOMMIT;`);
    const v = scalar(p, 'SELECT tier FROM customers WHERE id = 1');
    if (v !== 'gold') throw new Error(`expected tier=gold after COMMIT, got ${JSON.stringify(v)}`);
  });

  // A2 — transaction rollback actually rolls back
  check('txn-rollback-spans-statements', () => {
    const begin = t.engine === 'mysql' ? 'START TRANSACTION' : 'BEGIN';
    q(p, `${begin};\nUPDATE customers SET tier = 'NOPE' WHERE id = 1;\nROLLBACK;`);
    const v = scalar(p, 'SELECT tier FROM customers WHERE id = 1');
    if (v === 'NOPE') throw new Error('ROLLBACK did not undo the update — statements ran on different connections');
  });

  // A3 — temp table visible across statements (the backfill script shape)
  check('temp-table-spans-statements', () => {
    const create =
      t.engine === 'postgres'
        ? 'CREATE TEMPORARY TABLE tmp_top AS SELECT id, email FROM customers WHERE balance > 0'
        : t.engine === 'mysql'
          ? 'CREATE TEMPORARY TABLE tmp_top AS SELECT id, email FROM customers WHERE balance > 0'
          : 'CREATE TEMPORARY TABLE tmp_top AS SELECT id, email FROM customers WHERE balance > 0';
    const r = q(p, `${create};\nSELECT COUNT(*) AS n FROM tmp_top;\nDROP TABLE tmp_top;`);
    if (r.rows_affected == null) {
      // last stmt is DROP — fine, we mostly assert no "table not found"
    }
  });

  // A4 — session variables + PREPARE/EXECUTE (MySQL migration-script idiom)
  if (t.engine === 'mysql') {
    check('session-vars-prepare-execute', () => {
      const script = [
        `SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'FIREBASE_UID')`,
        `SET @sql = IF(@col_exists = 0, 'ALTER TABLE customers ADD COLUMN FIREBASE_UID VARCHAR(128) DEFAULT NULL', 'SELECT 1')`,
        `PREPARE stmt FROM @sql`,
        `EXECUTE stmt`,
        `DEALLOCATE PREPARE stmt`,
      ].join(';\n');
      q(p, script);
      const n = scalar(
        p,
        `SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'customers' AND COLUMN_NAME = 'FIREBASE_UID'`,
      );
      if (Number(n) !== 1) throw new Error(`conditional ALTER did not run (col count = ${JSON.stringify(n)})`);
      // Idempotent re-run must not error either.
      q(p, script);
    });

    check('start-transaction-not-preparable-1295', () => {
      // Regression: 'START TRANSACTION' used to die with error 1295 in
      // the prepared-statement protocol.
      q(p, `START TRANSACTION;\nSELECT 1;\nCOMMIT;`);
    });

    check('row-count-and-temp-table-backfill', () => {
      const script = [
        `START TRANSACTION`,
        `CREATE TEMPORARY TABLE tmp_bf AS SELECT id FROM customers WHERE status = 'ACTIVE'`,
        `UPDATE customers SET note = CONCAT(COALESCE(note, ''), '') WHERE id IN (SELECT id FROM tmp_bf)`,
        `SELECT ROW_COUNT() AS affected`,
        `DROP TEMPORARY TABLE tmp_bf`,
        `COMMIT`,
      ].join(';\n');
      q(p, script);
    });
  }

  // A5 — CTE + window function + join
  check('cte-window-join', () => {
    if (t.engine === 'mysql') {
      const v = serverVersion(t, p);
      if ((v.major ?? 5) < 8) {
        // 5.7 has no CTEs/window fns — plain join instead.
        const r = q(p, `SELECT c.full_name, COUNT(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.full_name ORDER BY c.id`);
        if (r.rows.length !== 4) throw new Error(`expected 4 rows, got ${r.rows.length}`);
        return;
      }
    }
    const r = q(
      p,
      `WITH totals AS (
         SELECT customer_id, SUM(total) AS lifetime
         FROM orders GROUP BY customer_id
       )
       SELECT c.full_name, t.lifetime,
              RANK() OVER (ORDER BY t.lifetime DESC) AS rnk
       FROM customers c JOIN totals t ON t.customer_id = c.id
       ORDER BY rnk`,
    );
    if (r.rows.length !== 2) throw new Error(`expected 2 ranked rows, got ${r.rows.length}`);
  });

  // A6 — multi-statement: result of LAST statement is returned
  check('multi-statement-returns-last', () => {
    const r = q(p, `SELECT 1 AS a;\nSELECT 2 AS b;`);
    if (String(r.rows[0]?.[0]) !== '2') throw new Error(`expected last-statement result 2, got ${JSON.stringify(r.rows[0])}`);
  });

  // A7 — errors surface with engine message
  check('error-surfaces', () => {
    const r = kit('query', p, { sql: 'SELEC broken FROM nowhere' });
    if (!('err' in r)) throw new Error('bad SQL did not error');
  });

  // A8 — DDL then re-SELECT same table in one session (cached-plan trap)
  check('ddl-then-reselect', () => {
    q(p, 'SELECT * FROM orders');
    q(p, `ALTER TABLE orders ADD COLUMN tmp_col INT`);
    q(p, 'SELECT * FROM orders');
    q(p, `ALTER TABLE orders DROP COLUMN tmp_col`);
  });

  // A9 — SHOW / EXPLAIN / utility statements
  check('utility-statements', () => {
    if (t.engine === 'mysql') {
      q(p, 'SHOW TABLES');
      q(p, 'EXPLAIN SELECT * FROM customers WHERE id = 1');
      q(p, 'USE ' + p.database + ';\nSELECT DATABASE();');
    } else if (t.engine === 'postgres') {
      q(p, 'SHOW server_version');
      q(p, 'EXPLAIN SELECT * FROM customers WHERE id = 1');
    } else {
      q(p, 'PRAGMA table_info(customers)');
      q(p, 'EXPLAIN QUERY PLAN SELECT * FROM customers WHERE id = 1');
    }
  });

  // A10 — apply_batch: mid-batch failure reports fail + skipped
  check('apply-batch-failure-shape', () => {
    const batch = kitOk('apply', p, {
      statements: [
        `UPDATE customers SET tier = 'silver' WHERE id = 2`,
        `UPDATE nope_table SET x = 1`,
        `UPDATE customers SET tier = 'bronze' WHERE id = 3`,
      ],
    }) as { committed: boolean; statements: Array<{ outcome: { kind: string } }> };
    const kinds = batch.statements.map((s) => s.outcome.kind);
    if (kinds[1] !== 'fail') throw new Error(`statement 2 should fail, got ${kinds.join(',')}`);
    if (kinds[2] !== 'skipped') throw new Error(`statement 3 should be skipped, got ${kinds.join(',')}`);
    if (t.engine !== 'mysql') {
      // Transactional engines must have rolled back statement 1.
      const v = scalar(p, 'SELECT tier FROM customers WHERE id = 2');
      if (v === 'silver') throw new Error('failed batch was not rolled back on a transactional engine');
    }
  });

  // A11 — CREATE/DROP DATABASE from the editor (server-level DDL)
  if (t.engine !== 'sqlite') {
    check('create-drop-database', () => {
      const admin = profileFor(t, t.adminDb!);
      q(admin, 'CREATE DATABASE e2e_scratch_db');
      q(admin, 'DROP DATABASE e2e_scratch_db');
    });
  }

  dropDb(t, dbName);
}

// === Phase B: schema diff round-trip ========================================

interface SchemaScenario {
  id: string;
  engines: DatabaseEngine[];
  /** SQL run against the TARGET db (the desired state). */
  divergeTarget?: (engine: DatabaseEngine, versionMajor: number) => string[];
  /** SQL run against the SOURCE db (state to migrate away from). */
  divergeSource?: (engine: DatabaseEngine, versionMajor: number) => string[];
  knownIssue?: string;
}

const SCHEMA_SCENARIOS: SchemaScenario[] = [
  {
    // The user-reported bug: CREATE TABLE with enum + timestamp defaults.
    id: 'create-table-enum-defaults',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: (e) =>
      e === 'mysql'
        ? [
            `CREATE TABLE reservations (
              reservation_id CHAR(36) NOT NULL,
              balance_id BIGINT NOT NULL,
              state ENUM('RESERVED','SETTLED','RELEASED') NOT NULL DEFAULT 'RESERVED',
              source ENUM('GRANT','PACK'),
              kind VARCHAR(16),
              creation_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
              settled_at TIMESTAMP NULL,
              PRIMARY KEY (reservation_id)
            )`,
          ]
        : e === 'postgres'
          ? [
              `CREATE TABLE reservations (
                reservation_id CHAR(36) NOT NULL,
                balance_id BIGINT NOT NULL,
                state VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
                source VARCHAR(16),
                kind VARCHAR(16),
                creation_date TIMESTAMPTZ DEFAULT now(),
                settled_at TIMESTAMPTZ,
                PRIMARY KEY (reservation_id)
              )`,
            ]
          : [
              `CREATE TABLE reservations (
                reservation_id TEXT NOT NULL,
                balance_id INTEGER NOT NULL,
                state TEXT NOT NULL DEFAULT 'RESERVED',
                source TEXT,
                kind TEXT,
                creation_date TEXT DEFAULT CURRENT_TIMESTAMP,
                settled_at TEXT,
                PRIMARY KEY (reservation_id)
              )`,
            ],
  },
  {
    id: 'add-columns-json-and-string-default',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: (e) =>
      e === 'mysql'
        ? [
            `ALTER TABLE customers ADD COLUMN unknown_columns JSON`,
            `ALTER TABLE customers ADD COLUMN signup_source VARCHAR(32) NOT NULL DEFAULT 'web'`,
          ]
        : e === 'postgres'
          ? [
              `ALTER TABLE customers ADD COLUMN unknown_columns JSONB`,
              `ALTER TABLE customers ADD COLUMN signup_source VARCHAR(32) NOT NULL DEFAULT 'web'`,
            ]
          : [
              `ALTER TABLE customers ADD COLUMN unknown_columns TEXT`,
              `ALTER TABLE customers ADD COLUMN signup_source TEXT NOT NULL DEFAULT 'web'`,
            ],
  },
  {
    // The XX_ORDERS case: widen an enum AND keep its quoted default.
    id: 'widen-enum-keep-default',
    engines: ['mysql'],
    divergeTarget: () => [
      `ALTER TABLE orders MODIFY COLUMN status ENUM('NEW','PAID','SHIPPED','CANCELLED','REFUNDED') NOT NULL DEFAULT 'NEW'`,
    ],
  },
  {
    id: 'add-indexes',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: () => [
      `CREATE INDEX idx_customers_tier ON customers (tier)`,
      `CREATE UNIQUE INDEX uq_customers_fullname ON customers (full_name)`,
    ],
  },
  {
    id: 'drop-plain-index',
    engines: ['mysql', 'postgres', 'sqlite'],
    // idx_orders_status exists on both; drop on target → diff drops on source.
    divergeTarget: (e) =>
      e === 'mysql' ? [`DROP INDEX idx_orders_status ON orders`] : [`DROP INDEX idx_orders_status`],
  },
  {
    id: 'drop-fk-backing-index',
    engines: ['mysql'],
    divergeTarget: () => [
      `ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer`,
      `DROP INDEX idx_orders_customer ON orders`,
      `ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)`,
    ],
    knownIssue:
      'MySQL auto-creates an index for the FK; dropping the explicit one on source needs the FK dropped first (errno 1553). Diff should either skip or order FK drop first.',
  },
  {
    id: 'drop-column',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: () => [`ALTER TABLE customers DROP COLUMN note`],
  },
  {
    // Two NEW tables where child FKs parent — diff must order parent
    // first or the child's CREATE fails.
    id: 'fk-ordered-create',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: (e) => {
      const idType = e === 'sqlite' ? 'INTEGER' : 'BIGINT';
      return [
        `CREATE TABLE warehouses (
          id ${idType} NOT NULL,
          label VARCHAR(64) NOT NULL,
          PRIMARY KEY (id)
        )`,
        `CREATE TABLE stock_moves (
          id ${idType} NOT NULL,
          warehouse_id ${idType} NOT NULL,
          qty ${e === 'sqlite' ? 'INTEGER' : 'INT'} NOT NULL,
          PRIMARY KEY (id),
          CONSTRAINT fk_stock_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
        )`,
      ];
    },
  },
  {
    // Reserved words + mixed case + spaces as identifiers. The diff
    // promises always-quoted SQL — this is where that promise is kept
    // or broken.
    id: 'hostile-identifiers',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: (e) => {
      const q = (n: string) => (e === 'mysql' ? '`' + n + '`' : '"' + n + '"');
      return [
        `CREATE TABLE ${q('Order Details')} (
          ${q('select')} ${e === 'sqlite' ? 'INTEGER' : 'INT'} NOT NULL,
          ${q('Group')} VARCHAR(32),
          ${q('naïve column')} VARCHAR(32),
          PRIMARY KEY (${q('select')})
        )`,
      ];
    },
  },
  {
    // New FK with a non-default referential action. add-column phase
    // must precede add-fk phase for this to apply.
    id: 'add-fk-with-actions',
    engines: ['mysql', 'postgres'],
    divergeTarget: () => [
      `ALTER TABLE orders ADD COLUMN backup_customer_id BIGINT NULL`,
      `ALTER TABLE orders ADD CONSTRAINT fk_orders_backup FOREIGN KEY (backup_customer_id) REFERENCES customers (id) ON DELETE SET NULL ON UPDATE CASCADE`,
    ],
  },
  {
    id: 'drop-fk',
    engines: ['mysql', 'postgres'],
    divergeTarget: (e) =>
      e === 'mysql'
        ? [`ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer`]
        : [`ALTER TABLE orders DROP CONSTRAINT fk_orders_customer`],
  },
  {
    // Same constraint name, different ON DELETE — must emit drop + add.
    id: 'redefine-fk-action',
    engines: ['mysql', 'postgres'],
    divergeTarget: (e) => [
      e === 'mysql'
        ? `ALTER TABLE orders DROP FOREIGN KEY fk_orders_customer`
        : `ALTER TABLE orders DROP CONSTRAINT fk_orders_customer`,
      `ALTER TABLE orders ADD CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE`,
    ],
  },
  {
    id: 'create-view',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeTarget: () => [
      `CREATE VIEW active_customers AS SELECT id, email, full_name FROM customers WHERE status = 'ACTIVE'`,
    ],
  },
  {
    id: 'drop-view-on-source',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeSource: () => [
      `CREATE VIEW doomed_view AS SELECT id FROM customers`,
    ],
  },
  {
    // Redefined view body — becomes drop + create bracketing the batch.
    id: 'redefine-view',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeSource: () => [
      `CREATE VIEW active_customers AS SELECT id, email FROM customers WHERE status = 'ACTIVE'`,
    ],
    divergeTarget: () => [
      `CREATE VIEW active_customers AS SELECT id, email, tier FROM customers WHERE status = 'ACTIVE'`,
    ],
  },
  {
    // A view over a column that's also being dropped: drop-view phase
    // must run before alter-drop or PG refuses the column drop.
    id: 'view-blocks-column-drop',
    engines: ['postgres'],
    divergeSource: () => [
      `CREATE VIEW note_view AS SELECT id, note FROM customers`,
    ],
    divergeTarget: () => [
      `ALTER TABLE customers DROP COLUMN note`,
    ],
  },
  {
    id: 'drop-table-on-source',
    engines: ['mysql', 'postgres', 'sqlite'],
    divergeSource: () => [
      `CREATE TABLE obsolete_stuff (id INT NOT NULL, PRIMARY KEY (id))`,
    ],
  },
];

function phaseSchemaDiff(t: SqlTarget) {
  for (const s of SCHEMA_SCENARIOS) {
    if (!s.engines.includes(t.engine)) continue;

    const srcName = 'e2e_src';
    const tgtName = 'e2e_tgt';
    let src: Profile, tgt: Profile;
    try {
      src = freshDb(t, srcName);
      tgt = freshDb(t, tgtName);
    } catch (e) {
      record(t.id, 'schema-diff', `${s.id}: setup`, 'fail', (e as Error).message);
      continue;
    }

    try {
      const version = serverVersion(t, src);
      const vMajor = version.major ?? 0;
      for (const stmt of s.divergeTarget?.(t.engine, vMajor) ?? []) kitOk('query', tgt, { sql: stmt });
      for (const stmt of s.divergeSource?.(t.engine, vMajor) ?? []) kitOk('query', src, { sql: stmt });

      // The label under which both sides diff. Mirrors comparing two
      // servers that host the same-named database.
      const label = t.engine === 'postgres' ? 'public' : t.engine === 'sqlite' ? 'main' : srcName;
      const before = diffSchemas(
        schemaOf(src, label) as never,
        schemaOf(tgt, label) as never,
        { engine: t.engine, sourceVersion: version },
      );
      if (before.length === 0) throw new Error('diff produced no changes for a real divergence');

      // Apply through the production apply_batch.
      const batch = kitOk('apply', src, { statements: before.map((c: DiffChange) => c.sql) }) as {
        statements: Array<{ outcome: { kind: string; error?: string } }>;
      };
      const failed = batch.statements.filter((st) => st.outcome.kind === 'fail');
      if (failed.length > 0) {
        throw new Error(
          `apply failed: ${failed.map((f) => f.outcome.error).join(' | ')} — SQL: ${before.map((c) => c.sql).join(' ')}`,
        );
      }

      const after = diffSchemas(
        schemaOf(src, label) as never,
        schemaOf(tgt, label) as never,
        { engine: t.engine, sourceVersion: version },
      );
      if (after.length > 0) {
        throw new Error(
          `did not converge — ${after.length} residual change(s): ${after.map((c) => c.label).join('; ')}`,
        );
      }
      record(t.id, 'schema-diff', s.id, 'pass');
    } catch (e) {
      record(t.id, 'schema-diff', s.id, s.knownIssue ? 'known-issue' : 'fail', (e as Error).message);
    } finally {
      dropDb(t, srcName);
      dropDb(t, tgtName);
    }
  }
}

// === Phase C: data diff round-trip ==========================================

function phaseDataDiff(t: SqlTarget) {
  const srcName = 'e2e_dsrc';
  const tgtName = 'e2e_dtgt';
  let src: Profile, tgt: Profile;
  try {
    src = freshDb(t, srcName);
    tgt = freshDb(t, tgtName);
  } catch (e) {
    record(t.id, 'data-diff', 'setup', 'fail', (e as Error).message);
    return;
  }

  try {
    const version = serverVersion(t, src);

    // Diverge target data: update (incl. quote + NULL transitions),
    // insert, delete.
    const diverge = [
      `UPDATE customers SET full_name = 'Bob O''Brien-Edited', balance = 42.42 WHERE id = 2`,
      `UPDATE customers SET note = NULL, tier = 'gold' WHERE id = 1`,
      `UPDATE customers SET note = 'now has a note' WHERE id = 3`,
      `DELETE FROM customers WHERE id = 4`,
      `INSERT INTO customers (email, full_name, status, tier, balance, updated_at) VALUES ('eve@example.com', 'Eve Extra', 'ACTIVE', 'free', 1.00, '2026-05-05 05:05:05')`,
      `UPDATE customers SET meta = '{"tags":["vip","edited"]}' WHERE id = 1`,
    ];
    for (const stmt of diverge) kitOk('query', tgt, { sql: stmt });

    const select = `SELECT id, email, full_name, status, tier, balance, meta, note, updated_at FROM customers ORDER BY id`;
    const sRes = q(src, select);
    const tRes = q(tgt, select);

    // Schema metadata for type-aware comparison comes from the real
    // introspection, like the app does.
    const label = t.engine === 'postgres' ? 'public' : t.engine === 'sqlite' ? 'main' : srcName;
    const schema = schemaOf(src, label);
    const customers = schema.schemas.flatMap((ns) => ns.tables).find((tb) => tb.name === 'customers');
    if (!customers) throw new Error('customers table missing from introspection');

    const diff = diffData(sRes as never, tRes as never, ['id'], {
      engine: t.engine,
      schemaColumns: customers.columns as never,
    });

    const expectMismatch = 3;
    const expectOnlyInSource = 1; // id=4 deleted on target
    const expectOnlyInTarget = 1; // eve inserted on target
    if (
      diff.mismatched.length !== expectMismatch ||
      diff.onlyInSource.length !== expectOnlyInSource ||
      diff.onlyInTarget.length !== expectOnlyInTarget
    ) {
      throw new Error(
        `diff shape wrong: mismatched=${diff.mismatched.length} (want ${expectMismatch}), ` +
          `onlyInSource=${diff.onlyInSource.length} (want ${expectOnlyInSource}), ` +
          `onlyInTarget=${diff.onlyInTarget.length} (want ${expectOnlyInTarget})`,
      );
    }
    record(t.id, 'data-diff', 'diff-shape', 'pass');

    // Sync source → match target (direction: source-to-target modifies source).
    const sync = buildSyncStatements(t.engine, label, 'customers', diff, {
      direction: 'source-to-target',
      writeSideVersion: version,
    });
    const statements = [...sync.updates, ...sync.deletes, ...sync.inserts];
    if (statements.length === 0) throw new Error('no sync statements generated');
    const batch = kitOk('apply', src, { statements }) as {
      statements: Array<{ outcome: { kind: string; error?: string } }>;
    };
    const failed = batch.statements.filter((st) => st.outcome.kind === 'fail');
    if (failed.length > 0) {
      throw new Error(`sync apply failed: ${failed.map((f) => f.outcome.error).join(' | ')}`);
    }

    const sAfter = q(src, select);
    const tAfter = q(tgt, select);
    const residual = diffData(sAfter as never, tAfter as never, ['id'], {
      engine: t.engine,
      schemaColumns: customers.columns as never,
    });
    const residualCount =
      residual.mismatched.length + residual.onlyInSource.length + residual.onlyInTarget.length;
    if (residualCount > 0) {
      const sample = residual.mismatched[0]?.changes
        ?.map((c) => `${c.column}: ${JSON.stringify(c.source)} vs ${JSON.stringify(c.target)}`)
        .join(', ');
      throw new Error(`did not converge — ${residualCount} residual rows (${sample ?? 'membership diff'})`);
    }
    record(t.id, 'data-diff', 'sync-converges', 'pass');
  } catch (e) {
    record(t.id, 'data-diff', 'round-trip', 'fail', (e as Error).message);
  } finally {
    dropDb(t, srcName);
    dropDb(t, tgtName);
  }
}

// === Main ===================================================================

function main() {
  console.log('Building testkit…');
  execSync('cargo build -p dbstudio-testkit', { cwd: resolve(__dirname, '../..'), stdio: 'inherit' });

  for (const t of TARGETS) {
    console.log(`\n=== ${t.id} (${t.engine}) ===`);
    phaseDriver(t);
    phaseSchemaDiff(t);
    phaseDataDiff(t);
  }

  // --- report ---
  const dir = resolve(__dirname, '../../test-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'full-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));

  const pass = results.filter((r) => r.outcome === 'pass').length;
  const fail = results.filter((r) => r.outcome === 'fail').length;
  const known = results.filter((r) => r.outcome === 'known-issue').length;

  const lines: string[] = [];
  lines.push('# dbstudio — full-flow E2E report', '');
  lines.push(`Generated: ${new Date().toISOString()}`, '');
  lines.push(`- Passed: ${pass}`, `- Failed: ${fail}`, `- Known issues: ${known}`, '');
  const failing = results.filter((r) => r.outcome === 'fail' || r.outcome === 'known-issue');
  if (failing.length) {
    lines.push('## Failures & known issues', '');
    for (const r of failing) {
      lines.push(`### ${r.target} · ${r.phase} · ${r.case} (${r.outcome})`, '', r.detail ?? '', '');
    }
  }
  lines.push('## All results', '', '| Target | Phase | Case | Outcome |', '|---|---|---|---|');
  for (const r of results) lines.push(`| ${r.target} | ${r.phase} | ${r.case} | ${r.outcome} |`);
  writeFileSync(resolve(dir, 'FULL-REPORT.md'), lines.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed, ${known} known issues`);
  console.log(`Report: test-results/FULL-REPORT.md`);
  if (fail > 0) process.exit(1);
}

main();
