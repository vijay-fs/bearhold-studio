// Generate INSERT / UPDATE / DELETE statements that bring the
// source side in line with the target. Same-engine only — the
// data-diff page enforces that, so the emitter assumes both ends
// share dialect quirks.
//
// Statements are inlined-literal, not parameterized — the user
// reviews + edits the SQL before running, same flow as schema diff.

import { quoteIdent, quoteStyleForEngine } from './sqlIdent';
import { formatSqlLiteral } from './sqlLiteral';
import type { DatabaseEngine } from './types';
import type { DataDiffResult } from './dataDiff';
import {
  capabilities,
  unknownVersion,
  type EngineVersion,
} from './engineVersion';

function tableRef(
  engine: DatabaseEngine,
  schema: string,
  table: string,
): string {
  const style = quoteStyleForEngine(engine);
  const t = quoteIdent(table, style);
  if (engine === 'sqlite' || !schema) return t;
  return `${quoteIdent(schema, style)}.${t}`;
}

// Engine-aware literal formatter lives in lib/sqlLiteral.ts. Local
// alias here so call sites stay readable.

export interface SyncSqlOptions {
  /** Apply direction: should source become like target (default), or
   *  should target become like source (reverse)? "Make source like
   *  target" is the schema-diff convention we mirror here. */
  direction?: 'source-to-target' | 'target-to-source';
  /** Server version of the side we WRITE to. Controls upsert flavor
   *  (ON CONFLICT vs ON DUPLICATE KEY UPDATE) and fallback shape when
   *  the engine supports neither. */
  writeSideVersion?: EngineVersion;
  /** Emit INSERTs as upserts. Guards against race conditions where the
   *  row was inserted between diff-preview and apply — a plain INSERT
   *  would 23505 and abort the transaction. Off by default so preview
   *  SQL stays simple; the diff page can flip it on with a checkbox. */
  upsertMode?: 'insert-only' | 'upsert';
}

export interface SyncStatements {
  /** Rows missing on source that we'll INSERT. */
  inserts: string[];
  /** Rows whose cells differ — one UPDATE per row, only the
   *  differing columns in the SET list. */
  updates: string[];
  /** Rows missing on target that we'll DELETE from source. */
  deletes: string[];
}

/**
 * Build the three statement lists. "source" is the side we'll
 * modify; "target" is the desired state. Direction reversal flips
 * which side we read from + write to.
 */
export function buildSyncStatements(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  diff: DataDiffResult,
  opts: SyncSqlOptions = {},
): SyncStatements {
  const style = quoteStyleForEngine(engine);
  const ref = tableRef(engine, schema, table);
  const direction = opts.direction ?? 'source-to-target';
  const upsertMode = opts.upsertMode ?? 'insert-only';
  const caps = capabilities(opts.writeSideVersion ?? unknownVersion(engine));
  const inserts: string[] = [];
  const updates: string[] = [];
  const deletes: string[] = [];

  // "Make source like target": source is missing → INSERT into source.
  // "Make target like source": target is missing → INSERT into target.
  const rowsToInsert =
    direction === 'source-to-target' ? diff.onlyInTarget : diff.onlyInSource;
  const rowsToDelete =
    direction === 'source-to-target' ? diff.onlyInSource : diff.onlyInTarget;

  // INSERTs: full column list. We always emit every column rather
  // than omitting ones that match defaults — the source row is the
  // authoritative shape and omitting columns risks silent defaulting.
  const colList = diff.columns.map((c) => quoteIdent(c, style)).join(', ');
  const pkSetTmp = new Set(diff.pkColumns);
  const nonPkCols = diff.columns.filter((c) => !pkSetTmp.has(c));
  for (const row of rowsToInsert) {
    const values = row.values.map((v) => formatSqlLiteral(v, engine)).join(', ');
    const base = `INSERT INTO ${ref} (${colList}) VALUES (${values})`;
    if (upsertMode === 'upsert' && nonPkCols.length > 0) {
      if (caps.onConflictDoUpdate) {
        // PG / SQLite form.
        const conflictCols = diff.pkColumns.map((c) => quoteIdent(c, style)).join(', ');
        const setClause = nonPkCols
          .map((c) => `${quoteIdent(c, style)} = EXCLUDED.${quoteIdent(c, style)}`)
          .join(', ');
        inserts.push(`${base} ON CONFLICT (${conflictCols}) DO UPDATE SET ${setClause};`);
        continue;
      }
      if (caps.onDuplicateKeyUpdate) {
        // MySQL form. VALUES(col) is the pre-8.0.20 syntax
        // that still works everywhere; 8.0.20+ prefers row aliases
        // but the older form is universally accepted.
        const setClause = nonPkCols
          .map((c) => `${quoteIdent(c, style)} = VALUES(${quoteIdent(c, style)})`)
          .join(', ');
        inserts.push(`${base} ON DUPLICATE KEY UPDATE ${setClause};`);
        continue;
      }
    }
    inserts.push(`${base};`);
  }

  // UPDATEs: only the differing columns appear in SET, and we never
  // touch PK columns (those are how we found the row). Direction
  // swaps which side provides the desired value.
  const pkSet = new Set(diff.pkColumns);
  for (const m of diff.mismatched) {
    const setClauses = m.changes
      .filter((c) => !pkSet.has(c.column))
      .map((c) => {
        const v = direction === 'source-to-target' ? c.target : c.source;
        return `${quoteIdent(c.column, style)} = ${formatSqlLiteral(v, engine)}`;
      });
    if (setClauses.length === 0) continue;
    const whereClauses = diff.pkColumns.map((pk, idx) => {
      const v = m.pkValues[idx];
      return `${quoteIdent(pk, style)} = ${formatSqlLiteral(v, engine)}`;
    });
    updates.push(
      `UPDATE ${ref} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(
        ' AND ',
      )};`,
    );
  }

  // DELETEs: one statement per row, keyed by PK. Composite PKs
  // produce an AND-joined WHERE.
  for (const row of rowsToDelete) {
    const pkPositions = diff.pkColumns.map((pk) => diff.columns.indexOf(pk));
    const whereClauses = diff.pkColumns.map((pk, idx) => {
      const pos = pkPositions[idx] ?? -1;
      const v = pos >= 0 ? row.values[pos] : null;
      return `${quoteIdent(pk, style)} = ${formatSqlLiteral(v, engine)}`;
    });
    deletes.push(`DELETE FROM ${ref} WHERE ${whereClauses.join(' AND ')};`);
  }

  return { inserts, updates, deletes };
}
