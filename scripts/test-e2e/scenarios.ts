// Test-scenario matrix. Each scenario names ONE thing the diff or
// data-diff engine has to get right. The harness iterates every
// scenario against every target in `infra/test/targets.json`.
//
// A scenario returns SQL that mutates the reference schema/data so the
// harness can then run the diff pipeline against the mutated copy and
// verify (a) we emitted syntactically valid SQL for the target's
// version, and (b) applying it converges the two sides.

export interface Scenario {
  id: string;
  /** Which engine families this scenario applies to. Skipped otherwise. */
  applicableTo: Array<'postgres' | 'mysql' | 'sqlite'>;
  /** Free-text description surfaced in the report. */
  what: string;
  /** SQL to run against the SOURCE side to create the divergence.
   *  Emitted as an array so multi-statement mutations can be applied
   *  atomically without splitting on `;`. */
  divergeSql: (engine: string) => string[];
  /** Category — grouped in the report. */
  category:
    | 'add-column'
    | 'drop-column'
    | 'alter-column-type'
    | 'alter-column-nullable'
    | 'rename-column'
    | 'add-index'
    | 'drop-index'
    | 'create-table'
    | 'drop-table'
    | 'data-insert'
    | 'data-update'
    | 'data-delete'
    | 'data-mixed';
}

// Convenience: reference-schema table names. Kept in one place so a
// rename of a fixture table doesn't ripple.
const T = {
  users: 'users',
  products: 'products',
  orders: 'orders',
  order_items: 'order_items',
};

export const SCENARIOS: Scenario[] = [
  // ---- add-column -----------------------------------------------------
  {
    id: 'add-column-nullable-text',
    category: 'add-column',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Add a nullable text column',
    divergeSql: (e) =>
      e.startsWith('mysql')
        ? [`ALTER TABLE ${T.users} ADD COLUMN nickname VARCHAR(64) NULL;`]
        : [`ALTER TABLE ${T.users} ADD COLUMN nickname TEXT;`],
  },
  {
    id: 'add-column-notnull-default',
    category: 'add-column',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Add NOT NULL column with default',
    divergeSql: (e) =>
      e.startsWith('mysql')
        ? [`ALTER TABLE ${T.users} ADD COLUMN signup_source VARCHAR(32) NOT NULL DEFAULT 'web';`]
        : [`ALTER TABLE ${T.users} ADD COLUMN signup_source TEXT NOT NULL DEFAULT 'web';`],
  },

  // ---- drop-column ----------------------------------------------------
  {
    id: 'drop-column',
    category: 'drop-column',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Drop a nullable column',
    divergeSql: () => [`ALTER TABLE ${T.users} DROP COLUMN last_login_at;`],
  },

  // ---- alter-column-type ---------------------------------------------
  {
    id: 'alter-column-type-widen',
    category: 'alter-column-type',
    applicableTo: ['postgres', 'mysql'],
    what: 'Widen VARCHAR/TEXT length',
    divergeSql: (e) =>
      e.startsWith('mysql')
        ? [`ALTER TABLE ${T.users} MODIFY COLUMN full_name VARCHAR(500) NOT NULL;`]
        : [`ALTER TABLE ${T.users} ALTER COLUMN full_name TYPE VARCHAR(500);`],
  },

  // ---- alter-column-nullable -----------------------------------------
  // The MySQL 5.7 <type> bug that started all this. If this passes on
  // mysql57, the concrete user report is fixed.
  {
    id: 'alter-column-nullable-mysql57',
    category: 'alter-column-nullable',
    applicableTo: ['mysql'],
    what: 'Toggle nullable on MySQL (MODIFY restates definition)',
    divergeSql: () => [`ALTER TABLE ${T.users} MODIFY COLUMN last_login_at DATETIME NOT NULL;`],
  },
  {
    id: 'alter-column-nullable-pg',
    category: 'alter-column-nullable',
    applicableTo: ['postgres'],
    what: 'DROP NOT NULL on Postgres',
    divergeSql: () => [`ALTER TABLE ${T.users} ALTER COLUMN full_name DROP NOT NULL;`],
  },

  // ---- rename-column (via CHANGE COLUMN pre-8.0 MySQL) ---------------
  {
    id: 'rename-column',
    category: 'rename-column',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Rename a column',
    divergeSql: (e) => {
      if (e === 'mysql') {
        // 5.7 needs CHANGE COLUMN with type restated; harness detects
        // this and expects the CHANGE COLUMN emit path.
        return [`ALTER TABLE ${T.users} CHANGE COLUMN full_name display_name VARCHAR(255) NOT NULL;`];
      }
      return [`ALTER TABLE ${T.users} RENAME COLUMN full_name TO display_name;`];
    },
  },

  // ---- indexes --------------------------------------------------------
  {
    id: 'add-simple-index',
    category: 'add-index',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Add a single-column non-unique index',
    divergeSql: () => [`CREATE INDEX users_full_name_idx ON ${T.users} (full_name);`],
  },
  {
    id: 'drop-index',
    category: 'drop-index',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Drop an existing index',
    divergeSql: (e) => {
      if (e.startsWith('mysql')) {
        return [`DROP INDEX orders_status_idx ON ${T.orders};`];
      }
      return [`DROP INDEX orders_status_idx;`];
    },
  },

  // ---- create-table / drop-table -------------------------------------
  {
    id: 'create-table',
    category: 'create-table',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Create a new table (target has it, source does not)',
    divergeSql: () => [], // handled by the diff-direction, not divergence SQL
  },

  // ---- data scenarios ------------------------------------------------
  {
    id: 'data-insert-single',
    category: 'data-insert',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Delete a row on source; data-diff should propose one INSERT',
    divergeSql: () => [`DELETE FROM ${T.users} WHERE id = 4;`],
  },
  {
    id: 'data-update-single',
    category: 'data-update',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Change one cell on source; data-diff should propose one UPDATE',
    divergeSql: () => [`UPDATE ${T.users} SET full_name = 'Alice A. (edited)' WHERE id = 1;`],
  },
  {
    id: 'data-delete-single',
    category: 'data-delete',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Insert an extra row on source; data-diff should propose one DELETE',
    divergeSql: () => [
      `INSERT INTO ${T.users} (email, full_name) VALUES ('eve@example.com', 'Eve Extra');`,
    ],
  },
  {
    id: 'data-mixed',
    category: 'data-mixed',
    applicableTo: ['postgres', 'mysql', 'sqlite'],
    what: 'Combination: insert + update + delete across two tables',
    divergeSql: () => [
      `DELETE FROM ${T.users} WHERE id = 4;`,
      `UPDATE ${T.users} SET full_name = 'Alice A. (edited)' WHERE id = 1;`,
      `INSERT INTO ${T.users} (email, full_name) VALUES ('eve@example.com', 'Eve Extra');`,
      `UPDATE ${T.products} SET price = price + 1 WHERE id = 1;`,
    ],
  },
];
