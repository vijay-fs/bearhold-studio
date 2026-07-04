// Decide whether a SQL workspace result is safe to round-trip via the
// editable grid. We light up edit/insert/delete only when the last
// statement is a single-table `SELECT * FROM <table> [WHERE / ORDER BY /
// LIMIT / OFFSET]` against a table we know from the introspected schema.
//
// We can't safely edit joined results (which row in which table did this
// cell come from?), projections (`SELECT col, lower(col2)` strips PK or
// computes values), or set-operations. So the parser is intentionally
// strict — it'd rather miss an opportunity than wrongly enable editing
// for an ambiguous query.

import type { ConnectionProfile } from './types';
import type { EditableConfig } from '@/components/ResultTable';
import type { Schema } from '@dbstudio/erd';

/**
 * Returns an EditableConfig when the SQL maps cleanly to a single known
 * table; null otherwise. Multi-statement scripts: only the last statement
 * is considered. Leading comments are skipped.
 */
export function detectEditableQuery(
  sql: string,
  schema: Schema,
  profile: ConnectionProfile,
  onChanged: () => void,
): EditableConfig | null {
  const last = lastStatement(sql);
  if (!last) return null;
  const ref = parseSelectStar(last);
  if (!ref) return null;

  // Resolve the table reference against the cached schema. When the user
  // omitted a schema qualifier, prefer the active database's default
  // (`public` for PG, `main` for SQLite, the profile's database for MySQL)
  // but fall back to any schema that has a matching table name — single
  // hit wins, ambiguous (same name in multiple schemas) bails out.
  const candidates = schema.schemas.flatMap((ns) =>
    ns.tables
      .filter((t) => caseInsensitiveEq(t.name, ref.table))
      .map((t) => ({ schemaName: ns.name, table: t })),
  );
  if (candidates.length === 0) return null;

  let match;
  if (ref.schema) {
    match = candidates.find((c) => caseInsensitiveEq(c.schemaName, ref.schema!));
  } else if (candidates.length === 1) {
    match = candidates[0];
  } else {
    const preferred = defaultSchemaName(profile);
    match = candidates.find((c) => caseInsensitiveEq(c.schemaName, preferred));
    // Ambiguous — multiple schemas have a table with this name and the
    // user didn't qualify. Bail rather than guess.
    if (!match) return null;
  }
  if (!match) return null;

  const pkColumns = match.table.primary_key?.columns ?? [];
  if (pkColumns.length === 0) return null; // No PK → can't compose a WHERE.

  return {
    profile,
    schema: match.schemaName,
    table: match.table.name,
    pkColumns,
    tableColumns: match.table.columns,
    foreignKeys: match.table.foreign_keys ?? [],
    onChanged,
  };
}

/** Default schema for a connection — used as a tie-breaker when the user
 *  wrote `SELECT * FROM foo` without qualifying. */
function defaultSchemaName(profile: ConnectionProfile): string {
  switch (profile.engine) {
    case 'mysql':
      return profile.database;
    case 'sqlite':
      return 'main';
    case 'postgres':
    default:
      return 'public';
  }
}

function caseInsensitiveEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Pull the last semicolon-separated statement, respecting strings/comments
 *  so we don't trip over `';'` inside literals.
 *
 *  A trailing `;` at the very end of the input is a *terminator*, not a
 *  *separator* — every Postgres / MySQL / SQLite user writes
 *  `SELECT * FROM products;` and means "one statement that ends here", not
 *  "two statements: SELECT ..., then nothing". We strip that trailing
 *  semicolon (and any trailing whitespace) before scanning for boundaries,
 *  so a single-statement script terminating in `;` is recognised as such. */
function lastStatement(sql: string): string | null {
  // Trim trailing whitespace, then a single optional terminator.
  let input = sql.replace(/\s+$/, '');
  if (input.endsWith(';')) input = input.slice(0, -1);

  const boundaries: number[] = [-1];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    const n = input[i + 1];
    // Line comment
    if (c === '-' && n === '-') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (c === '/' && n === '*') {
      i += 2;
      while (i + 1 < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i = Math.min(i + 2, input.length);
      continue;
    }
    // Single-quoted string
    if (c === "'") {
      i++;
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    // Double-quoted identifier
    if (c === '"') {
      i++;
      while (i < input.length && input[i] !== '"') i++;
      i++;
      continue;
    }
    // Backticked identifier (MySQL)
    if (c === '`') {
      i++;
      while (i < input.length && input[i] !== '`') i++;
      i++;
      continue;
    }
    if (c === ';') boundaries.push(i);
    i++;
  }
  const lastBoundary = boundaries[boundaries.length - 1] ?? -1;
  const candidate = input.slice(lastBoundary + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

interface TableRef {
  schema?: string;
  table: string;
}

/**
 * Parse `SELECT * FROM <table>` with optional schema qualifier, optional
 * WHERE / ORDER BY / LIMIT / OFFSET / GROUP BY / HAVING tail. No JOINs,
 * no comma-separated tables, no projections.
 */
function parseSelectStar(stmt: string): TableRef | null {
  // Strip leading comments/whitespace.
  const stripped = stripLeadingNoise(stmt);
  // The structural regex: SELECT *, FROM, one identifier reference, then
  // either end-of-statement or one of a known set of trailing clauses.
  const re = /^select\s+\*\s+from\s+(`[^`]+`|"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(`[^`]+`|"[^"]+"|[a-zA-Z_][\w$]*))?(?:\s+(?:where|order\s+by|limit|offset|group\s+by|having)\b[\s\S]*)?\s*;?\s*$/i;
  const m = stripped.match(re);
  if (!m) return null;
  const first = unquoteIdent(m[1] ?? '');
  const second = m[2] ? unquoteIdent(m[2]) : null;
  if (second) {
    return { schema: first, table: second };
  }
  return { table: first };
}

function stripLeadingNoise(s: string): string {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c ?? '')) {
      i++;
      continue;
    }
    if (c === '-' && s[i + 1] === '-') {
      i += 2;
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i = Math.min(i + 2, s.length);
      continue;
    }
    break;
  }
  return s.slice(i);
}

function unquoteIdent(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  if (s.startsWith('`') && s.endsWith('`')) {
    return s.slice(1, -1).replace(/``/g, '`');
  }
  return s;
}
