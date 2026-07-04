// Engine-aware DDL builders for the table-edit dialogs. The output is
// SQL that goes through the standard runQuery path — no separate DDL
// endpoint needed since DDL is just SQL. Each helper returns the
// statement as a single line so the preview is readable in the dialog.

import { softQuoteIdent, quoteStyleForEngine } from './sqlIdent';
import type { DatabaseEngine } from './types';
import {
  capabilities,
  unknownVersion,
  type EngineVersion,
} from './engineVersion';

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

/** MySQL pre-8.0 needed `CHANGE COLUMN old new TYPE`; modern MySQL
 *  (8.0+) accepts `RENAME COLUMN old TO new` just like Postgres and
 *  SQLite. Version-aware: on old MySQL we fall back to CHANGE COLUMN,
 *  which needs the type restated — the caller must pass it. */
export function buildRenameColumn(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  oldName: string,
  newName: string,
  opts: { version?: EngineVersion; dataType?: string } = {},
): string {
  const style = quoteStyleForEngine(engine);
  const caps = capabilities(opts.version ?? unknownVersion(engine));
  const ref = tableRef(engine, schema, table);
  const oldId = softQuoteIdent(oldName, style);
  const newId = softQuoteIdent(newName, style);
  if (!caps.renameColumnSyntax && engine === 'mysql') {
    if (!opts.dataType) {
      throw new Error(
        'This MySQL version needs CHANGE COLUMN, which requires the column data type. Pass opts.dataType.',
      );
    }
    return `ALTER TABLE ${ref} CHANGE COLUMN ${oldId} ${newId} ${opts.dataType};`;
  }
  return `ALTER TABLE ${ref} RENAME COLUMN ${oldId} TO ${newId};`;
}

export interface AlterColumnSpec {
  /** The current name; the column we're targeting (pre-rename). */
  oldName: string;
  /** The desired final type, exactly as it should appear in DDL. */
  dataType: string;
  /** Used by MySQL's MODIFY COLUMN, which restates every
   *  column attribute and silently drops anything you omit. We need
   *  these to preserve the existing nullable / default. PG and SQLite
   *  ignore them. */
  nullable: boolean;
  /** Default expression as the user would type it after `DEFAULT`.
   *  null/empty means "no DEFAULT clause" — for MySQL this also drops
   *  any existing default, since MODIFY COLUMN restates everything. */
  default?: string | null;
}

/** Change a column's data type. Engine-specific because:
 *  - Postgres uses `ALTER COLUMN <col> TYPE <newtype>`, and the
 *    implicit USING cast covers numeric/text widenings.
 *  - MySQL uses `MODIFY COLUMN <col> <full new defn>` and
 *    silently drop any column attributes you don't restate, so we
 *    have to re-emit nullable + default explicitly.
 *  - SQLite has no in-place ALTER COLUMN TYPE; the documented path is
 *    rebuild-the-table, which is too invasive for this dialog. We
 *    throw with a clear message so the caller can show it instead of
 *    silently emitting wrong SQL.
 */
export function buildAlterColumnType(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  spec: AlterColumnSpec,
): string {
  const style = quoteStyleForEngine(engine);
  const colId = softQuoteIdent(spec.oldName, style);
  const ref = tableRef(engine, schema, table);
  if (engine === 'sqlite') {
    throw new Error(
      'SQLite does not support changing a column\'s type in place. Recreate the table to change the type.',
    );
  }
  if (engine === 'mysql') {
    const parts: string[] = [`ALTER TABLE ${ref} MODIFY COLUMN ${colId}`, spec.dataType];
    if (!spec.nullable) parts.push('NOT NULL');
    if (spec.default && spec.default.trim()) {
      parts.push(`DEFAULT ${spec.default.trim()}`);
    }
    return parts.join(' ') + ';';
  }
  // Postgres. We don't emit a USING clause — the engine
  // accept the implicit cast for the common type widenings; for
  // anything cross-family the engine error message is more useful
  // than a guessed USING expression.
  return `ALTER TABLE ${ref} ALTER COLUMN ${colId} TYPE ${spec.dataType};`;
}
