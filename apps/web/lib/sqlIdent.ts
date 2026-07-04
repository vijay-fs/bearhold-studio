// Identifier emission helpers.
//
// When dbstudio generates SQL on the user's behalf (the open-table flow,
// autocomplete insertions) we'd rather emit `SELECT * FROM shop.order_items`
// than `SELECT * FROM "shop"."order_items"` — humans read the unquoted
// form. But quotes do something semantically real: they preserve case and
// let you reference reserved words as identifiers. So we only drop them
// when both are guaranteed safe.
//
// Postgres folds unquoted identifiers to lowercase before lookup
// (`Order_Items` → `order_items`). MySQL's behavior depends on
// `lower_case_table_names`, but lowercase-only names are safe under every
// setting. SQLite is case-insensitive. So "all lowercase + no specials"
// is the universally-safe shape.
//
// User-typed input is always fine either way — the engine resolves both
// forms. This module governs only the *generated* SQL we emit.

const SAFE_UNQUOTED = /^[a-z_][a-z0-9_]*$/;

/** Reserved words from Postgres + MySQL + ANSI that realistically appear as
 *  table or column names in the wild. When the user has a table called
 *  `order` or a column called `user`, we must quote — otherwise the
 *  emitted SQL is a parse error. Lowercased for the set lookup. */
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric',
  'authorization', 'between', 'binary', 'both', 'by', 'case', 'cast', 'check',
  'collate', 'collation', 'column', 'concurrently', 'constraint', 'create',
  'cross', 'current_catalog', 'current_date', 'current_role', 'current_schema',
  'current_time', 'current_timestamp', 'current_user', 'database', 'databases',
  'default', 'deferrable', 'delete', 'desc', 'describe', 'distinct', 'do',
  'drop', 'else', 'end', 'except', 'explain', 'false', 'fetch', 'for',
  'foreign', 'freeze', 'from', 'full', 'function', 'grant', 'group', 'having',
  'if', 'ilike', 'in', 'index', 'initially', 'inner', 'insert', 'intersect',
  'interval', 'into', 'is', 'isnull', 'join', 'key', 'lateral', 'leading',
  'left', 'like', 'limit', 'localtime', 'localtimestamp', 'natural', 'not',
  'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer',
  'overlaps', 'placing', 'precision', 'primary', 'procedure', 'range',
  'references', 'returning', 'right', 'rollback', 'row', 'rows', 'schema',
  'select', 'session_user', 'set', 'show', 'similar', 'some', 'symmetric',
  'table', 'tablesample', 'then', 'time', 'timestamp', 'to', 'trailing',
  'true', 'union', 'unique', 'update', 'use', 'user', 'using', 'values',
  'variadic', 'verbose', 'view', 'when', 'where', 'window', 'with',
]);

export type QuoteStyle = 'ansi' | 'backtick';

export function isSafeUnquoted(name: string): boolean {
  return SAFE_UNQUOTED.test(name) && !RESERVED.has(name);
}

/** Quote an identifier with the engine's preferred style. Always quotes —
 *  use when the SQL is hidden from the user (Rust driver builds them this
 *  way, and our preview-SQL dialogs match for transparency). */
export function quoteIdent(name: string, style: QuoteStyle): string {
  if (style === 'backtick') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/** Emit `name` unquoted when safe; otherwise return the quoted form for
 *  the given engine style. Use for SQL the user will read or edit. */
export function softQuoteIdent(name: string, style: QuoteStyle): string {
  if (isSafeUnquoted(name)) return name;
  return quoteIdent(name, style);
}

/** Convenience: convert a DatabaseEngine to the matching quote style. */
export function quoteStyleForEngine(engine: string): QuoteStyle {
  return engine === 'mysql' ? 'backtick' : 'ansi';
}
