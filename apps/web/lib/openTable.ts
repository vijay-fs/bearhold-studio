// "Open a table" unified flow.
//
// Anywhere the user picks a table — ER diagram node, sidebar table list,
// command palette — funnels through here. We build a `SELECT * FROM
// "schema"."table" LIMIT N` (dialect-quoted for the engine), open it as a
// fresh tab in the connection's SQL workspace, and auto-run. The SQL
// workspace's editable-query detector then lights up cell-edit / insert /
// delete on the result — same flow as if the user typed the query
// themselves.
//
// We use the existing palette-load event + sessionStorage as the transport
// so both "already on the SQL page" and "navigating to it" cases land in
// the same handler.

import type { Route } from 'next';

import type { ConnectionProfile } from './types';
import { softQuoteIdent, quoteStyleForEngine } from './sqlIdent';
import type { RowLimit } from '@/store/gridPrefs';

const DEFAULT_ROW_LIMIT: RowLimit = 10;

/** Engine-aware `SELECT * FROM <table> [LIMIT N]`. Emits bare identifiers
 *  when both the schema and the table names are lowercase, alphanumeric,
 *  and not reserved — so the generated SQL reads like SQL a person would
 *  write. Quotes only the identifiers that need it. Passing `null` for
 *  `limit` skips the LIMIT clause entirely (the "All" option). */
export function buildSelectStarSql(
  engine: ConnectionProfile['engine'],
  schema: string,
  table: string,
  limit: RowLimit = DEFAULT_ROW_LIMIT,
): string {
  const style = quoteStyleForEngine(engine);
  const t = softQuoteIdent(table, style);
  const limitClause = limit == null ? '' : ` LIMIT ${limit}`;
  // SQLite has no real schemas (every table lives in `main`); for MySQL we
  // omit the schema qualifier when it matches the connection's active
  // database in caller-side code, but here we always emit what we're
  // given. The caller passes '' to mean "no qualifier".
  if (engine === 'sqlite' || !schema) {
    return `SELECT * FROM ${t}${limitClause};`;
  }
  const s = softQuoteIdent(schema, style);
  return `SELECT * FROM ${s}.${t}${limitClause};`;
}

/** `SELECT * FROM <table> WHERE <column> = <literal> LIMIT N` — used by
 *  the FK jump affordance in the result grid. The literal is inlined as
 *  a SQL literal (numbers as-is, strings single-quoted with `''` escape,
 *  booleans/null as keywords) rather than bound — the value comes from
 *  cell data the user is already looking at, and the generated SQL ends
 *  up in the editor where the user can review or edit it before re-run.
 *  Mixing binds + literal display would be more work for no real safety
 *  gain (the literal goes straight to their engine, same as if they
 *  typed it themselves). */
export function buildFilteredSelectSql(
  engine: ConnectionProfile['engine'],
  schema: string,
  table: string,
  column: string,
  value: unknown,
  limit: RowLimit = DEFAULT_ROW_LIMIT,
): string {
  const style = quoteStyleForEngine(engine);
  const t = softQuoteIdent(table, style);
  const c = softQuoteIdent(column, style);
  const tableRef =
    engine === 'sqlite' || !schema
      ? t
      : `${softQuoteIdent(schema, style)}.${t}`;
  const limitClause = limit == null ? '' : ` LIMIT ${limit}`;
  return `SELECT * FROM ${tableRef} WHERE ${c} = ${sqlLiteral(value)}${limitClause};`;
}

/** Render a JS value as a SQL literal for inlining into a WHERE clause.
 *  Strings get single-quote escaping. Numbers/booleans/null map to their
 *  SQL keywords. Anything else is JSON-stringified and wrapped — works
 *  for jsonb FKs (rare) and surfaces oddities visibly in the generated
 *  SQL so the user can fix them by hand. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/** Open the table in the connection's SQL workspace. Builds the SELECT,
 *  hands it to the workspace via the shared palette-load channel, and
 *  navigates (no-op if already on /sql). The workspace honors the
 *  `tableRef` on the event so a tab dedicated to this table is reused
 *  rather than a new tab created on every click. */
export function openTableInSql(
  router: { push: (href: Route) => void },
  profile: ConnectionProfile,
  schemaName: string,
  tableName: string,
  limit: RowLimit = DEFAULT_ROW_LIMIT,
): void {
  const sql = buildSelectStarSql(profile.engine, schemaName, tableName, limit);
  loadSqlInWorkspace(router, profile, sql, true, {
    schema: schemaName,
    table: tableName,
  });
}

/** Generic "open arbitrary SQL in the connection's SQL workspace" helper.
 *  Same transport as `openTableInSql` — sessionStorage covers the
 *  navigation race, the custom event covers the already-mounted case.
 *  Used by History / Snippets pages when the user clicks Load or Re-run.
 *  Pass `tableRef` to mark the tab as bound to a specific table so a
 *  re-open of the same table re-focuses rather than spawns a tab. */
export function loadSqlInWorkspace(
  router: { push: (href: Route) => void },
  profile: ConnectionProfile,
  sql: string,
  autoRun: boolean,
  tableRef?: { schema: string; table: string },
): void {
  // Both transports carry the SAME nonce. The SQL page dedupes on it,
  // so whichever path arrives first wins and the other is a no-op —
  // fixing the double-open (mount-drain AND event both firing) and the
  // stale-key replay (a leftover payload auto-running against a
  // different connection on the next navigation).
  const nonce = crypto.randomUUID();
  sessionStorage.setItem('dbstudio.pendingSqlNonce', nonce);
  sessionStorage.setItem('dbstudio.pendingSql', sql);
  sessionStorage.setItem('dbstudio.pendingSqlAutoRun', autoRun ? '1' : '0');
  if (tableRef) {
    sessionStorage.setItem(
      'dbstudio.pendingSqlTableRef',
      JSON.stringify(tableRef),
    );
  } else {
    sessionStorage.removeItem('dbstudio.pendingSqlTableRef');
  }
  router.push(`/sql?cid=${profile.id}` as Route);
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('palette-load-sql', {
        detail: { sql, autoRun, tableRef, nonce },
      }),
    );
  }, 50);
}
