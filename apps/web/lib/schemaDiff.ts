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
  Index,
  Schema,
  Table,
} from '@dbstudio/erd';

import type { DatabaseEngine } from './types';
import { softQuoteIdent, quoteStyleForEngine } from './sqlIdent';

export type DiffChangeKind =
  | 'create-table'
  | 'drop-table'
  | 'add-column'
  | 'drop-column'
  | 'alter-column-type'
  | 'alter-column-nullable'
  | 'add-index'
  | 'drop-index';

export interface DiffChange {
  kind: DiffChangeKind;
  schema: string;
  table: string;
  /** Free-text label rendered above the SQL block. */
  label: string;
  /** Generated ALTER / CREATE / DROP statement to apply this change.
   *  Editable in the UI before execution. */
  sql: string;
}

interface DiffOptions {
  engine: DatabaseEngine;
}

/** Compute the changes needed for `source` to match `target`. The
 *  output is grouped by table and ordered: creates first (so new
 *  tables exist before any FK references), then column mutations,
 *  then drops last (so dependents go before owners). */
export function diffSchemas(
  source: Schema,
  target: Schema,
  options: DiffOptions,
): DiffChange[] {
  const { engine } = options;
  const changes: DiffChange[] = [];

  const sourceTables = indexTables(source);
  const targetTables = indexTables(target);

  // -- CREATE TABLE for every table in target but not source. -----------
  for (const [key, tt] of targetTables) {
    if (!sourceTables.has(key)) {
      changes.push({
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
    diffColumns(engine, st, tt, changes);
    diffIndexes(engine, st, tt, changes);
  }

  // -- DROP TABLE for every table in source but not target. Drops go
  // -- last so any FKs that referenced this table from a dropped or
  // -- mutated table are also gone first.
  for (const [key, st] of sourceTables) {
    if (!targetTables.has(key)) {
      changes.push({
        kind: 'drop-table',
        schema: st.schema,
        table: st.name,
        label: `Drop ${st.schema}.${st.name}`,
        sql: `DROP TABLE ${tableRef(engine, st.schema, st.name)};`,
      });
    }
  }

  return changes;
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
  source: Table,
  target: Table,
  changes: DiffChange[],
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
        sql: buildAddColumn(engine, source.schema, source.name, tc),
      });
      continue;
    }
    if (sc.data_type.toLowerCase() !== tc.data_type.toLowerCase()) {
      changes.push({
        kind: 'alter-column-type',
        schema: source.schema,
        table: source.name,
        label: `Change ${name} type: ${sc.data_type} → ${tc.data_type}`,
        sql: buildAlterColumnType(engine, source.schema, source.name, name, tc.data_type),
      });
    }
    if (sc.nullable !== tc.nullable) {
      changes.push({
        kind: 'alter-column-nullable',
        schema: source.schema,
        table: source.name,
        label: `${tc.nullable ? 'Drop' : 'Set'} NOT NULL on ${name}`,
        sql: buildAlterColumnNullable(
          engine,
          source.schema,
          source.name,
          name,
          tc.nullable,
        ),
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
        sql: `ALTER TABLE ${tableRef(engine, source.schema, source.name)} DROP COLUMN ${softQuoteIdent(
          name,
          quoteStyleForEngine(engine),
        )};`,
      });
    }
  }
}

function diffIndexes(
  engine: DatabaseEngine,
  source: Table,
  target: Table,
  changes: DiffChange[],
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
        sql: buildCreateIndex(engine, source.schema, source.name, ti),
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
        sql: `DROP INDEX ${softQuoteIdent(name, quoteStyleForEngine(engine))};`,
      });
    }
  }
}

// ---- SQL builders ------------------------------------------------------

function tableRef(engine: DatabaseEngine, schema: string, table: string): string {
  const style = quoteStyleForEngine(engine);
  const t = softQuoteIdent(table, style);
  if (engine === 'sqlite' || !schema) return t;
  return `${softQuoteIdent(schema, style)}.${t}`;
}

function buildCreateTable(engine: DatabaseEngine, t: Table): string {
  const style = quoteStyleForEngine(engine);
  const lines: string[] = [];
  for (const c of t.columns) {
    const parts = [softQuoteIdent(c.name, style), c.data_type];
    if (!c.nullable) parts.push('NOT NULL');
    if (c.default) parts.push(`DEFAULT ${c.default}`);
    lines.push('  ' + parts.join(' '));
  }
  if (t.primary_key && t.primary_key.columns.length > 0) {
    lines.push(
      '  PRIMARY KEY (' +
        t.primary_key.columns.map((c) => softQuoteIdent(c, style)).join(', ') +
        ')',
    );
  }
  // FKs are emitted as `FOREIGN KEY (cols) REFERENCES schema.table(cols)`.
  // We keep them inline rather than separate ALTERs so the CREATE is a
  // single, copy-pastable block — easier to review and edit before
  // applying.
  for (const fk of t.foreign_keys) {
    lines.push(
      '  CONSTRAINT ' +
        softQuoteIdent(fk.name, style) +
        ' FOREIGN KEY (' +
        fk.columns.map((c) => softQuoteIdent(c, style)).join(', ') +
        ') REFERENCES ' +
        tableRef(engine, fk.references_schema, fk.references_table) +
        ' (' +
        fk.references_columns.map((c) => softQuoteIdent(c, style)).join(', ') +
        ')',
    );
  }
  return `CREATE TABLE ${tableRef(engine, t.schema, t.name)} (\n${lines.join(',\n')}\n);`;
}

function buildAddColumn(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  c: Column,
): string {
  const style = quoteStyleForEngine(engine);
  const parts: string[] = [
    'ALTER TABLE',
    tableRef(engine, schema, table),
    'ADD COLUMN',
    softQuoteIdent(c.name, style),
    c.data_type,
  ];
  if (!c.nullable) parts.push('NOT NULL');
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  return parts.join(' ') + ';';
}

/** ALTER COLUMN TYPE syntax varies by engine — Postgres uses `ALTER
 *  COLUMN col TYPE new_type`, MySQL `MODIFY COLUMN col new_type`. We
 *  emit the engine-appropriate form for the common cases and let the
 *  user hand-edit for anything more exotic (USING clauses, casts). */
function buildAlterColumnType(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  column: string,
  newType: string,
): string {
  const style = quoteStyleForEngine(engine);
  const ref = tableRef(engine, schema, table);
  if (engine === 'mysql' || engine === 'mariadb') {
    return `ALTER TABLE ${ref} MODIFY COLUMN ${softQuoteIdent(column, style)} ${newType};`;
  }
  return `ALTER TABLE ${ref} ALTER COLUMN ${softQuoteIdent(column, style)} TYPE ${newType};`;
}

function buildAlterColumnNullable(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  column: string,
  nullable: boolean,
): string {
  const style = quoteStyleForEngine(engine);
  const ref = tableRef(engine, schema, table);
  const colId = softQuoteIdent(column, style);
  if (engine === 'mysql' || engine === 'mariadb') {
    // MySQL requires re-stating the full column definition in MODIFY;
    // we don't have the type handy here, so emit a note + best-effort.
    return `-- MySQL: re-state the column type below, then change NULL\nALTER TABLE ${ref} MODIFY COLUMN ${colId} <type> ${nullable ? 'NULL' : 'NOT NULL'};`;
  }
  return nullable
    ? `ALTER TABLE ${ref} ALTER COLUMN ${colId} DROP NOT NULL;`
    : `ALTER TABLE ${ref} ALTER COLUMN ${colId} SET NOT NULL;`;
}

function buildCreateIndex(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  idx: Index,
): string {
  const style = quoteStyleForEngine(engine);
  return `${idx.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX'} ${softQuoteIdent(idx.name, style)} ON ${tableRef(engine, schema, table)} (${idx.columns.map((c) => softQuoteIdent(c, style)).join(', ')});`;
}

