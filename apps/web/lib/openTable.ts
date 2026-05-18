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

const DEFAULT_ROW_LIMIT = 1000;

/** Engine-aware `SELECT * FROM <table> LIMIT N`. Emits bare identifiers
 *  when both the schema and the table names are lowercase, alphanumeric,
 *  and not reserved — so the generated SQL reads like SQL a person would
 *  write. Quotes only the identifiers that need it. */
export function buildSelectStarSql(
  engine: ConnectionProfile['engine'],
  schema: string,
  table: string,
  limit: number = DEFAULT_ROW_LIMIT,
): string {
  const style = quoteStyleForEngine(engine);
  const t = softQuoteIdent(table, style);
  // SQLite has no real schemas (every table lives in `main`); for MySQL we
  // omit the schema qualifier when it matches the connection's active
  // database in caller-side code, but here we always emit what we're
  // given. The caller passes '' to mean "no qualifier".
  if (engine === 'sqlite' || !schema) {
    return `SELECT * FROM ${t} LIMIT ${limit};`;
  }
  const s = softQuoteIdent(schema, style);
  return `SELECT * FROM ${s}.${t} LIMIT ${limit};`;
}

/** Open the table in the connection's SQL workspace. Builds the SELECT,
 *  hands it to the workspace via the shared palette-load channel, and
 *  navigates (no-op if already on /sql). */
export function openTableInSql(
  router: { push: (href: Route) => void },
  profile: ConnectionProfile,
  schemaName: string,
  tableName: string,
): void {
  const sql = buildSelectStarSql(profile.engine, schemaName, tableName);
  // sessionStorage handles the "navigating in" race where the event fires
  // before the page mounts; the event handles the "already mounted" case.
  sessionStorage.setItem('dbstudio.pendingSql', sql);
  sessionStorage.setItem('dbstudio.pendingSqlAutoRun', '1');
  router.push(`/connections/${profile.id}/sql` as Route);
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent('palette-load-sql', { detail: { sql, autoRun: true } }),
    );
  }, 50);
}
