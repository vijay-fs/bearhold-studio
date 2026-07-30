// Compute the set of changes needed to bring a "source" schema in line
// with a "target" schema. The diff is engine-agnostic (it works on the
// normalized `Schema` shape returned by every driver) and the SQL we
// generate is plain ALTER TABLE / CREATE TABLE / DROP TABLE — which
// every supported engine accepts with the soft-quoting we already use
// elsewhere.
//
// Important honest caveats baked into the output:
//   - Type changes are emitted as best-effort `ALTER COLUMN ... TYPE`
//     statements. Some engines (older MySQL, SQLite) need different
//     syntax and may need the user to edit before applying.
//   - We don't try to handle column renames (no source-level identity).
//     A rename will show up as drop + add.
//   - Index/FK changes are reported but not applied automatically when
//     the diff is for a new column — the user picks which to keep.

import type {
  Column,
  ForeignKey,
  Index,
  RefAction,
  Schema,
  Table,
  View,
} from '@dbstudio/erd';

import type { DatabaseEngine } from './types';
import { quoteIdent, quoteStyleForEngine } from './sqlIdent';
import {
  capabilities,
  unknownVersion,
  type EngineVersion,
} from './engineVersion';
import {
  parentFirstOrder,
  childFirstOrder,
  tableKey,
  rankMap,
} from './tableGraph';

// Diff SQL is always quoted, never soft-quoted. The soft-quoter is for
// SQL the user reads (open-table flow, autocomplete inserts) — it
// emits bare identifiers when they're guaranteed-safe lowercase
// non-reserved names so the SQL reads naturally. The diff page runs
// SQL against the live database; any identifier that escapes
// quoting because of a case-sensitivity gap in the reserved-words
// list (e.g. mixed-case column names, engine-specific reserved
// words we don't track) turns into a runtime syntax error. Always
// quoting closes the gap by construction at the cost of slightly
// busier preview SQL.
const ident = quoteIdent;

export type DiffChangeKind =
  | 'create-table'
  | 'drop-table'
  | 'add-column'
  | 'drop-column'
  | 'alter-column-type'
  | 'alter-column-nullable'
  | 'add-index'
  | 'drop-index'
  | 'add-fk'
  | 'drop-fk'
  | 'create-view'
  | 'drop-view';

/** Phase groups the change into a coarse "when does it run" bucket.
 *  Ordering rule inside a single Apply batch:
 *
 *    1. `create`      — new tables (parents first, respecting FKs)
 *    2. `alter-add`   — additive column changes (add / widen / nullable)
 *    3. `alter-index` — new indexes
 *    4. `drop-index`  — dropped indexes (before their columns leave)
 *    5. `alter-drop`  — dropped columns (before their tables leave)
 *    6. `drop`        — dropped tables (children first, respecting FKs)
 *
 *  Any FK-referencing tables under `create` land after the tables
 *  they reference; drops go the other way. This is what stops the
 *  "delete on products violates FK on order_items" class of error. */
export type DiffPhase =
  | 'drop-view'
  | 'drop-fk'
  | 'create'
  | 'alter-add'
  | 'alter-index'
  | 'add-fk'
  | 'create-view'
  | 'drop-index'
  | 'alter-drop'
  | 'drop';

export interface DiffChange {
  kind: DiffChangeKind;
  schema: string;
  table: string;
  /** Free-text label rendered above the SQL block. */
  label: string;
  /** Generated ALTER / CREATE / DROP statement to apply this change.
   *  Editable in the UI before execution. */
  sql: string;
  /** Ordering phase. Populated by `diffSchemas` — the diff caller
   *  can trust that iterating the returned array in order is
   *  batch-apply-safe. */
  phase: DiffPhase;
}

function phaseForKind(k: DiffChangeKind): DiffPhase {
  switch (k) {
    // Views drop FIRST: Postgres refuses to drop columns/tables a view
    // still references, and a redefined view (drop + create pair)
    // must release the old definition before table shapes change.
    case 'drop-view':
      return 'drop-view';
    // FKs drop before any index/column/table they depend on leaves.
    case 'drop-fk':
      return 'drop-fk';
    case 'create-table':
      return 'create';
    case 'add-column':
    case 'alter-column-type':
    case 'alter-column-nullable':
      return 'alter-add';
    case 'add-index':
      return 'alter-index';
    // FKs attach after tables, columns and (for MySQL) indexes exist.
    case 'add-fk':
      return 'add-fk';
    // Views (re)create last among additive changes — every table and
    // column they reference exists by now.
    case 'create-view':
      return 'create-view';
    case 'drop-index':
      return 'drop-index';
    case 'drop-column':
      return 'alter-drop';
    case 'drop-table':
      return 'drop';
  }
}

const PHASE_RANK: Record<DiffPhase, number> = {
  'drop-view': 0,
  'drop-fk': 1,
  create: 2,
  'alter-add': 3,
  'alter-index': 4,
  'add-fk': 5,
  'create-view': 6,
  'drop-index': 7,
  'alter-drop': 8,
  drop: 9,
};

interface DiffOptions {
  engine: DatabaseEngine;
  /** Server version of the SOURCE (the side we run the SQL against).
   *  When omitted, the safe-minimum capability set is used — every
   *  emitter falls back to the syntax that works on the oldest
   *  supported version of that engine. */
  sourceVersion?: EngineVersion;
}

/** Compute the changes needed for `source` to match `target`. The
 *  output is grouped by table and ordered: creates first (so new
 *  tables exist before any FK references), then column mutations,
 *  then drops last (so dependents go before owners). */
type RawChange = Omit<DiffChange, 'phase'>;

export function diffSchemas(
  source: Schema,
  target: Schema,
  options: DiffOptions,
): DiffChange[] {
  const { engine } = options;
  const version = options.sourceVersion ?? unknownVersion(engine);
  const caps = capabilities(version);
  const raw: RawChange[] = [];

  const sourceTables = indexTables(source);
  const targetTables = indexTables(target);

  // -- CREATE TABLE for every table in target but not source. -----------
  for (const [key, tt] of targetTables) {
    if (!sourceTables.has(key)) {
      raw.push({
        kind: 'create-table',
        schema: tt.schema,
        table: tt.name,
        label: `Create ${tt.schema}.${tt.name}`,
        sql: buildCreateTable(engine, tt),
      });
    }
  }

  // -- ALTER COLUMN sets for every table that exists on both sides. -----
  for (const [key, tt] of targetTables) {
    const st = sourceTables.get(key);
    if (!st) continue;
    diffColumns(engine, caps, st, tt, raw);
    diffIndexes(engine, caps, st, tt, raw);
    diffForeignKeys(engine, st, tt, raw);
  }

  diffViews(engine, source, target, raw);

  // -- DROP TABLE for every table in source but not target. Drops go
  // -- last so any FKs that referenced this table from a dropped or
  // -- mutated table are also gone first.
  for (const [key, st] of sourceTables) {
    if (!targetTables.has(key)) {
      raw.push({
        kind: 'drop-table',
        schema: st.schema,
        table: st.name,
        label: `Drop ${st.schema}.${st.name}`,
        sql: `DROP TABLE ${tableRef(engine, st.schema, st.name)};`,
      });
    }
  }

  return orderChanges(raw, source, target);
}

/** Sort emitted changes into a batch-apply-safe order:
 *   1. Bucket by phase (creates first, drops last)
 *   2. Inside `create` — parent tables before children
 *      (using the TARGET graph, because the CREATE order matches
 *       the target's FK topology)
 *   3. Inside `drop`   — child tables before parents
 *      (using the SOURCE graph — that's the state at drop time)
 *   4. Inside every other phase — group by table so all changes on
 *      one table are contiguous, but tables themselves stay in
 *      parent-first order for predictability.
 *
 *  The resulting `DiffChange[]` can be iterated top-to-bottom and
 *  fed into an atomic transaction — no FK conflicts by construction. */
function orderChanges(
  raw: RawChange[],
  source: Schema,
  target: Schema,
): DiffChange[] {
  const targetRank = rankMap(parentFirstOrder(target));
  const sourceRankReverse = rankMap(childFirstOrder(source));

  const decorated = raw.map((c, originalIdx) => {
    const phase = phaseForKind(c.kind);
    const key = tableKey(c.schema, c.table);
    // For drops, we want child-first ordering, so use the reversed
    // source graph. Everything else uses parent-first from target.
    const dependencyRank = (phase === 'drop' || phase === 'alter-drop')
      ? sourceRankReverse.get(key) ?? Number.MAX_SAFE_INTEGER
      : targetRank.get(key) ?? Number.MAX_SAFE_INTEGER;
    return { c, phase, dependencyRank, originalIdx };
  });

  decorated.sort((a, b) => {
    const pa = PHASE_RANK[a.phase];
    const pb = PHASE_RANK[b.phase];
    if (pa !== pb) return pa - pb;
    if (a.dependencyRank !== b.dependencyRank) {
      return a.dependencyRank - b.dependencyRank;
    }
    // Stable within a table: preserve emit order.
    return a.originalIdx - b.originalIdx;
  });

  return decorated.map(({ c, phase }) => ({ ...c, phase }));
}

function indexTables(schema: Schema): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      out.set(`${ns.name}.${t.name}`, t);
    }
  }
  return out;
}

function diffColumns(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  source: Table,
  target: Table,
  changes: RawChange[],
): void {
  const sCols = new Map(source.columns.map((c) => [c.name, c]));
  const tCols = new Map(target.columns.map((c) => [c.name, c]));

  for (const [name, tc] of tCols) {
    const sc = sCols.get(name);
    if (!sc) {
      changes.push({
        kind: 'add-column',
        schema: source.schema,
        table: source.name,
        label: `Add column ${name}`,
        sql: buildAddColumn(engine, caps, source.schema, source.name, tc),
      });
      continue;
    }
    if (sc.data_type.toLowerCase() !== tc.data_type.toLowerCase()) {
      changes.push({
        kind: 'alter-column-type',
        schema: source.schema,
        table: source.name,
        label: `Change ${name} type: ${sc.data_type} → ${tc.data_type}`,
        // MySQL MODIFY restates the whole column definition and silently
        // drops any attribute you omit — so we pass the source column's
        // current nullable/default alongside the new type. PG ignores
        // these extras.
        sql: buildAlterColumnType(
          engine,
          caps,
          source.schema,
          source.name,
          name,
          tc.data_type,
          { nullable: tc.nullable, default: tc.default ?? null },
        ),
      });
    }
    if (sc.nullable !== tc.nullable) {
      changes.push({
        kind: 'alter-column-nullable',
        schema: source.schema,
        table: source.name,
        label: `${tc.nullable ? 'Drop' : 'Set'} NOT NULL on ${name}`,
        // Pass the effective type for the MySQL MODIFY restate path.
        // Target type wins if it changed; otherwise keep source's.
        sql: buildAlterColumnNullable(engine, caps, source.schema, source.name, name, tc.nullable, {
          dataType: (tc.data_type || sc.data_type) as string,
          default: tc.default ?? sc.default ?? null,
        }),
      });
    }
  }

  for (const [name] of sCols) {
    if (!tCols.has(name)) {
      changes.push({
        kind: 'drop-column',
        schema: source.schema,
        table: source.name,
        label: `Drop column ${name}`,
        sql: `ALTER TABLE ${tableRef(engine, source.schema, source.name)} DROP COLUMN ${ident(
          name,
          quoteStyleForEngine(engine),
        )};`,
      });
    }
  }
}

function diffIndexes(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  source: Table,
  target: Table,
  changes: RawChange[],
): void {
  // Indexes are diffed by name. Skip primary indexes — those follow the
  // primary-key constraint, which we don't try to alter automatically.
  const sIdx = new Map(
    source.indexes.filter((i) => !i.primary).map((i) => [i.name, i]),
  );
  const tIdx = new Map(
    target.indexes.filter((i) => !i.primary).map((i) => [i.name, i]),
  );
  for (const [name, ti] of tIdx) {
    if (!sIdx.has(name)) {
      changes.push({
        kind: 'add-index',
        schema: source.schema,
        table: source.name,
        label: `Add index ${name}`,
        sql: buildCreateIndex(engine, caps, source.schema, source.name, ti),
      });
    }
  }
  for (const [name] of sIdx) {
    if (!tIdx.has(name)) {
      changes.push({
        kind: 'drop-index',
        schema: source.schema,
        table: source.name,
        label: `Drop index ${name}`,
        sql: buildDropIndex(engine, caps, source.schema, source.name, name),
      });
    }
  }
}

/** FK diffing. Compared by constraint name; a same-named FK whose
 *  shape (columns, referenced table/columns, ON DELETE / ON UPDATE)
 *  differs is redefined as drop + add — phase ordering guarantees the
 *  drop lands first.
 *
 *  SQLite is excluded entirely: it cannot ALTER foreign keys (a table
 *  rebuild is required), so emitting DDL here would only produce
 *  guaranteed-failing statements. */
function diffForeignKeys(
  engine: DatabaseEngine,
  source: Table,
  target: Table,
  changes: RawChange[],
): void {
  if (engine === 'sqlite') return;
  const style = quoteStyleForEngine(engine);
  const sFks = new Map(source.foreign_keys.map((f) => [f.name, f]));
  const tFks = new Map(target.foreign_keys.map((f) => [f.name, f]));

  const dropFk = (name: string) => {
    const keyword = engine === 'mysql' ? 'FOREIGN KEY' : 'CONSTRAINT';
    changes.push({
      kind: 'drop-fk',
      schema: source.schema,
      table: source.name,
      label: `Drop foreign key ${name}`,
      sql: `ALTER TABLE ${tableRef(engine, source.schema, source.name)} DROP ${keyword} ${ident(name, style)};`,
    });
  };
  const addFk = (fk: ForeignKey) => {
    changes.push({
      kind: 'add-fk',
      schema: source.schema,
      table: source.name,
      label: `Add foreign key ${fk.name}`,
      sql:
        `ALTER TABLE ${tableRef(engine, source.schema, source.name)} ADD CONSTRAINT ${ident(fk.name, style)} ` +
        foreignKeyClause(engine, fk) +
        ';',
    });
  };

  for (const [name, tf] of tFks) {
    const sf = sFks.get(name);
    if (!sf) {
      addFk(tf);
    } else if (fkSignature(sf) !== fkSignature(tf)) {
      dropFk(name);
      addFk(tf);
    }
  }
  for (const [name] of sFks) {
    if (!tFks.has(name)) dropFk(name);
  }
}

function fkSignature(fk: ForeignKey): string {
  return JSON.stringify([
    fk.columns,
    fk.references_schema,
    fk.references_table,
    fk.references_columns,
    fk.on_delete ?? 'no_action',
    fk.on_update ?? 'no_action',
  ]);
}

function refActionSql(action: RefAction): string {
  switch (action) {
    case 'no_action':
      return 'NO ACTION';
    case 'restrict':
      return 'RESTRICT';
    case 'cascade':
      return 'CASCADE';
    case 'set_null':
      return 'SET NULL';
    case 'set_default':
      return 'SET DEFAULT';
  }
}

function foreignKeyClause(engine: DatabaseEngine, fk: ForeignKey): string {
  const style = quoteStyleForEngine(engine);
  let clause =
    'FOREIGN KEY (' +
    fk.columns.map((c) => ident(c, style)).join(', ') +
    ') REFERENCES ' +
    tableRef(engine, fk.references_schema, fk.references_table) +
    ' (' +
    fk.references_columns.map((c) => ident(c, style)).join(', ') +
    ')';
  // NO ACTION is every engine's default — emitting it would make the
  // diff noisier without changing behavior.
  if (fk.on_delete && fk.on_delete !== 'no_action') {
    clause += ` ON DELETE ${refActionSql(fk.on_delete)}`;
  }
  if (fk.on_update && fk.on_update !== 'no_action') {
    clause += ` ON UPDATE ${refActionSql(fk.on_update)}`;
  }
  return clause;
}

/** View diffing: presence by name, redefinition by normalized
 *  definition text. A changed view becomes drop + create — the two
 *  phases bracket every table change, so a view can be rebuilt on top
 *  of columns that are themselves added in the same batch.
 *
 *  Definition comparison is engine-honest: both sides come from the
 *  same engine's canonical form (pg_get_viewdef / VIEW_DEFINITION /
 *  sqlite_master.sql), so whitespace-insensitive equality is
 *  reliable. When either side has no stored definition we only diff
 *  presence — never guess at a body we can't see. */
function diffViews(
  engine: DatabaseEngine,
  source: Schema,
  target: Schema,
  changes: RawChange[],
): void {
  const sViews = indexViews(source);
  const tViews = indexViews(target);

  const dropView = (v: View) => {
    changes.push({
      kind: 'drop-view',
      schema: v.schema,
      table: v.name,
      label: `Drop view ${v.name}`,
      sql: `DROP VIEW ${tableRef(engine, v.schema, v.name)};`,
    });
  };
  const createView = (v: View) => {
    changes.push({
      kind: 'create-view',
      schema: v.schema,
      table: v.name,
      label: `Create view ${v.name}`,
      sql: buildCreateView(engine, v),
    });
  };

  for (const [key, tv] of tViews) {
    const sv = sViews.get(key);
    if (!sv) {
      if (tv.definition) createView(tv);
      continue;
    }
    if (
      sv.definition &&
      tv.definition &&
      normalizeViewDef(sv.definition) !== normalizeViewDef(tv.definition)
    ) {
      dropView(sv);
      createView(tv);
    }
  }
  for (const [key, sv] of sViews) {
    if (!tViews.has(key)) dropView(sv);
  }
}

function indexViews(schema: Schema): Map<string, View> {
  const out = new Map<string, View>();
  for (const ns of schema.schemas) {
    for (const v of ns.views) out.set(tableKey(v.schema, v.name), v);
  }
  return out;
}

function normalizeViewDef(def: string): string {
  return def.trim().replace(/;\s*$/, '').replace(/\s+/g, ' ');
}

function buildCreateView(engine: DatabaseEngine, v: View): string {
  const def = (v.definition ?? '').trim().replace(/;\s*$/, '');
  // SQLite stores the complete CREATE VIEW statement in sqlite_master;
  // PG and MySQL store only the SELECT body.
  if (/^\s*CREATE\b/i.test(def)) {
    return `${def};`;
  }
  return `CREATE VIEW ${tableRef(engine, v.schema, v.name)} AS ${def};`;
}

/** Engine-correct `DROP INDEX`. The previous version used a bare
 *  index name for every engine, which is wrong two different ways:
 *
 *    - Postgres: indexes live in a schema. Without qualification,
 *      PG resolves the name against `search_path`; the default
 *      `"$user", public` skips schemas like `shop`, so a valid
 *      index reads as "does not exist".
 *    - MySQL: `DROP INDEX name` alone is a syntax error; the correct
 *      form is `DROP INDEX name ON table`.
 *
 *  We now emit:
 *    PG      →  DROP INDEX IF EXISTS "schema"."name"
 *    MySQL   →  DROP INDEX `name` ON `schema`.`table`
 *    SQLite  →  DROP INDEX IF EXISTS "name"   (indexes are global)
 *
 *  `IF EXISTS` is added when the capability model reports the
 *  engine supports it — that also makes the statement safely
 *  re-runnable if it accidentally lands in a batch twice. */
function buildDropIndex(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  schema: string,
  table: string,
  name: string,
): string {
  const style = quoteStyleForEngine(engine);
  const idName = ident(name, style);
  const ifExists = caps.createIndexIfNotExists ? ' IF EXISTS' : '';
  if (engine === 'mysql') {
    return `ALTER TABLE ${tableRef(engine, schema, table)} DROP INDEX ${idName};`;
  }
  if (engine === 'sqlite') {
    return `DROP INDEX${ifExists} ${idName};`;
  }
  // Postgres (+ future Cockroach). Schema-qualify so we don't rely
  // on the driver session's search_path.
  const qualified =
    schema && engine === 'postgres'
      ? `${ident(schema, style)}.${idName}`
      : idName;
  return `DROP INDEX${ifExists} ${qualified};`;
}

// ---- SQL builders ------------------------------------------------------

function tableRef(engine: DatabaseEngine, schema: string, table: string): string {
  const style = quoteStyleForEngine(engine);
  const t = ident(table, style);
  if (engine === 'sqlite' || !schema) return t;
  return `${ident(schema, style)}.${t}`;
}

function buildCreateTable(engine: DatabaseEngine, t: Table): string {
  const style = quoteStyleForEngine(engine);
  const lines: string[] = [];
  for (const c of t.columns) {
    const parts = [ident(c.name, style), c.data_type];
    if (!c.nullable) parts.push('NOT NULL');
    // MySQL: a TIMESTAMP column without an explicit NULL is implicitly
    // NOT NULL DEFAULT '0000-00-00 00:00:00' (5.7 default sql_mode
    // then rejects its own implicit default with error 1067). Emitting
    // NULL for every nullable column is valid on all MySQL versions
    // and defuses the trap.
    else if (engine === 'mysql') parts.push('NULL');
    if (c.default) parts.push(`DEFAULT ${c.default}`);
    lines.push('  ' + parts.join(' '));
  }
  if (t.primary_key && t.primary_key.columns.length > 0) {
    lines.push(
      '  PRIMARY KEY (' +
        t.primary_key.columns.map((c) => ident(c, style)).join(', ') +
        ')',
    );
  }
  // FKs are emitted as `FOREIGN KEY (cols) REFERENCES schema.table(cols)`.
  // We keep them inline rather than separate ALTERs so the CREATE is a
  // single, copy-pastable block — easier to review and edit before
  // applying.
  for (const fk of t.foreign_keys) {
    lines.push('  CONSTRAINT ' + ident(fk.name, style) + ' ' + foreignKeyClause(engine, fk));
  }
  return `CREATE TABLE ${tableRef(engine, t.schema, t.name)} (\n${lines.join(',\n')}\n);`;
}

function buildAddColumn(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  schema: string,
  table: string,
  c: Column,
): string {
  const style = quoteStyleForEngine(engine);
  const parts: string[] = [
    'ALTER TABLE',
    tableRef(engine, schema, table),
    caps.addColumnIfNotExists ? 'ADD COLUMN IF NOT EXISTS' : 'ADD COLUMN',
    ident(c.name, style),
    c.data_type,
  ];
  if (!c.nullable) parts.push('NOT NULL');
  // See buildCreateTable: explicit NULL defuses MySQL's implicit
  // NOT-NULL-with-zero-default behavior on TIMESTAMP columns.
  else if (engine === 'mysql') parts.push('NULL');
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  return parts.join(' ') + ';';
}

interface MysqlModifyExtras {
  nullable: boolean;
  default: string | null;
}

/** ALTER COLUMN TYPE syntax varies by engine — Postgres uses `ALTER
 *  COLUMN col TYPE new_type`, MySQL `MODIFY COLUMN col new_type ...`
 *  which restates every attribute. For MySQL we require the effective
 *  nullable+default so the restate doesn't silently drop them. */
function buildAlterColumnType(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  schema: string,
  table: string,
  column: string,
  newType: string,
  extras: MysqlModifyExtras,
): string {
  const style = quoteStyleForEngine(engine);
  const ref = tableRef(engine, schema, table);
  const colId = ident(column, style);
  if (caps.modifyColumnRestates) {
    const parts = [`ALTER TABLE ${ref} MODIFY COLUMN ${colId}`, newType];
    if (!extras.nullable) parts.push('NOT NULL');
    if (extras.default && extras.default.trim()) parts.push(`DEFAULT ${extras.default.trim()}`);
    return parts.join(' ') + ';';
  }
  // PG. USING is optional but if capability says we support
  // it, we emit an implicit-cast-friendly `USING colId::newType` so
  // cross-family widenings (varchar -> int) don't die at runtime.
  const usingClause = caps.usingClauseOnAlterType
    ? ` USING ${colId}::${newType}`
    : '';
  return `ALTER TABLE ${ref} ALTER COLUMN ${colId} TYPE ${newType}${usingClause};`;
}

interface MysqlNullableExtras {
  /** The column's current data type — required by MySQL MODIFY, which
   *  drops any attribute we don't restate. */
  dataType: string;
  default: string | null;
}

function buildAlterColumnNullable(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  schema: string,
  table: string,
  column: string,
  nullable: boolean,
  extras: MysqlNullableExtras,
): string {
  const style = quoteStyleForEngine(engine);
  const ref = tableRef(engine, schema, table);
  const colId = ident(column, style);
  if (caps.modifyColumnRestates) {
    // MySQL restates the full column definition on every MODIFY. Any
    // attribute we don't repeat gets dropped silently — so we always
    // emit the type, and the nullable + default as we know them.
    const parts = [`ALTER TABLE ${ref} MODIFY COLUMN ${colId}`, extras.dataType];
    if (!nullable) parts.push('NOT NULL');
    else parts.push('NULL');
    if (extras.default && extras.default.trim()) parts.push(`DEFAULT ${extras.default.trim()}`);
    return parts.join(' ') + ';';
  }
  return nullable
    ? `ALTER TABLE ${ref} ALTER COLUMN ${colId} DROP NOT NULL;`
    : `ALTER TABLE ${ref} ALTER COLUMN ${colId} SET NOT NULL;`;
}

function buildCreateIndex(
  engine: DatabaseEngine,
  caps: ReturnType<typeof capabilities>,
  schema: string,
  table: string,
  idx: Index,
): string {
  const style = quoteStyleForEngine(engine);
  const kw = idx.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  const ifNotExists = caps.createIndexIfNotExists ? ' IF NOT EXISTS' : '';
  return `${kw}${ifNotExists} ${ident(idx.name, style)} ON ${tableRef(engine, schema, table)} (${idx.columns.map((c) => ident(c, style)).join(', ')});`;
}

