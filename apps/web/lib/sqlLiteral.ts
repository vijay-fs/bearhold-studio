// Engine-aware SQL literal formatting.
//
// Shared by every code path that inlines values into a generated
// statement — copy-as-INSERT in the result grid, data-diff sync SQL,
// FK-jump filtered SELECTs, etc. Keeping one implementation here
// means an engine-specific quirk (MySQL datetime format, backslash
// escapes) gets fixed exactly once.

import type { DatabaseEngine } from './types';

/** ISO-8601 datetime-shaped strings — YYYY-MM-DD followed by `T` or
 *  space, time, optional fraction, optional timezone. Plain dates
 *  and times are NOT matched (they're already valid everywhere). */
const ISO_DATETIME_RE =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Normalize a datetime-shaped string for the given engine. MySQL +
 * TIMESTAMP columns reject the `T` separator and
 * the trailing timezone suffix, so we translate `2026-06-05T07:15:00+00:00`
 * into `2026-06-05 07:15:00`. The translation drops the offset under
 * the assumption that values flow in already-UTC; mixing local-time
 * columns with offset-bearing source data is a schema issue this
 * helper can't paper over.
 *
 * Postgres and SQLite accept the ISO form natively, so the input is
 * returned unchanged for those.
 */
function normalizeDatetimeForEngine(
  s: string,
  engine: DatabaseEngine | undefined,
): string {
  if (engine !== 'mysql') return s;
  const m = ISO_DATETIME_RE.exec(s);
  if (!m) return s;
  const [, date, time, frac] = m;
  return frac ? `${date} ${time}.${frac}` : `${date} ${time}`;
}

/** Escape the inside of a single-quoted SQL string literal. Always
 *  double up embedded single quotes. For MySQL the default
 *  `sql_mode` interprets backslash escapes (`\n`, `\t`, `\\`, etc.)
 *  inside string literals, so a literal backslash in source data
 *  gets re-decoded on paste; doubling the backslash side-steps that.
 *  Postgres and SQLite treat `\` as a literal byte in plain `'...'`
 *  strings (PG only escapes inside `E'...'`), so we leave them.
 *
 *  When the caller has probed the MySQL server and knows
 *  `NO_BACKSLASH_ESCAPES` is in sql_mode, we DON'T double the
 *  backslash — the server treats it as literal already, so doubling
 *  would corrupt the value. */
function escapeStringForEngine(
  s: string,
  engine: DatabaseEngine | undefined,
  opts: { noBackslashEscapes?: boolean } = {},
): string {
  const quoted = s.replace(/'/g, "''");
  if (engine === 'mysql' && !opts.noBackslashEscapes) {
    return quoted.replace(/\\/g, '\\\\');
  }
  return quoted;
}

/**
 * Render any JS value as an inline SQL literal for the target
 * engine.
 *
 * - `null` / `undefined` → `NULL`
 * - finite `number` → as-is; NaN / Infinity → `NULL`
 * - `boolean` → `TRUE` / `FALSE` (universal across our engines)
 * - `Date` → ISO normalized per engine, single-quoted
 * - `string` that looks like ISO datetime → normalized + quoted
 * - other `string` → quoted, with engine-aware escaping
 * - everything else (objects/arrays from jsonb/json columns) →
 *   JSON-stringified + quoted
 */
export interface SqlLiteralOptions {
  /** Set by callers that have probed the MySQL server and detected
   *  NO_BACKSLASH_ESCAPES in sql_mode. Suppresses backslash-doubling. */
  noBackslashEscapes?: boolean;
}

export function formatSqlLiteral(
  value: unknown,
  engine?: DatabaseEngine,
  opts: SqlLiteralOptions = {},
): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) {
    return `'${normalizeDatetimeForEngine(value.toISOString(), engine)}'`;
  }
  if (typeof value === 'string') {
    const reshaped = normalizeDatetimeForEngine(value, engine);
    return `'${escapeStringForEngine(reshaped, engine, opts)}'`;
  }
  return `'${escapeStringForEngine(JSON.stringify(value), engine, opts)}'`;
}
