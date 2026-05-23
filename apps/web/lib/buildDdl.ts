// Engine-aware DDL builders for the table-edit dialogs. The output is
// SQL that goes through the standard runQuery path — no separate DDL
// endpoint needed since DDL is just SQL. Each helper returns the
// statement as a single line so the preview is readable in the dialog.

import { softQuoteIdent, quoteStyleForEngine } from './sqlIdent';
import type { DatabaseEngine } from './types';

/** Schema-qualified table reference, engine-correct. Mirrors the
 *  pattern used by buildSelectStarSql — SQLite has no real schemas so
 *  the qualifier is omitted there. */
function tableRef(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): string {
  const style = quoteStyleForEngine(engine);
  const t = softQuoteIdent(table, style);
  if (engine === 'sqlite' || !schema) return t;
  return `${softQuoteIdent(schema, style)}.${t}`;
}

export interface AddColumnSpec {
  name: string;
  dataType: string;
  nullable: boolean;
  /** Default expression as the user would type it after `DEFAULT`. Pass
   *  null/empty when omitting the clause entirely. Values are inlined,
   *  not bound — the user reviews the generated SQL before it runs. */
  default?: string | null;
}

export function buildAddColumn(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  spec: AddColumnSpec,
): string {
  const style = quoteStyleForEngine(engine);
  const colId = softQuoteIdent(spec.name, style);
  const parts: string[] = [
    'ALTER TABLE',
    tableRef(engine, schema, table),
    'ADD COLUMN',
    colId,
    spec.dataType,
  ];
  if (!spec.nullable) parts.push('NOT NULL');
  if (spec.default && spec.default.trim()) parts.push(`DEFAULT ${spec.default.trim()}`);
  return parts.join(' ') + ';';
}

export function buildDropColumn(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  column: string,
): string {
  const style = quoteStyleForEngine(engine);
  return `ALTER TABLE ${tableRef(engine, schema, table)} DROP COLUMN ${softQuoteIdent(
    column,
    style,
  )};`;
}

/** MySQL/MariaDB pre-8.0 needed `CHANGE COLUMN old new TYPE`; modern
 *  MySQL (8.0+) and MariaDB (10.5+) accept `RENAME COLUMN old TO new`
 *  just like Postgres/SQLite. We emit the modern form everywhere — if
 *  someone's pointed at an ancient MySQL, the engine error will make
 *  the issue obvious and they can hand-write the CHANGE COLUMN. */
export function buildRenameColumn(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  oldName: string,
  newName: string,
): string {
  const style = quoteStyleForEngine(engine);
  return `ALTER TABLE ${tableRef(engine, schema, table)} RENAME COLUMN ${softQuoteIdent(
    oldName,
    style,
  )} TO ${softQuoteIdent(newName, style)};`;
}
