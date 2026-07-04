// Data diff: row-by-row, cell-by-cell comparison of two tables.
//
// Caller arranges the SELECTs (so we can be transport-agnostic and
// reuse the standard runQuery path). We're given two QueryResult-
// shaped payloads + the PK column list, and we produce three
// buckets the UI can render and emit sync SQL for.
//
// Same-engine only — see `engineCanDiff`. Cross-engine adds type-
// coercion gnarls that don't belong in a v1.

import type { DatabaseEngine, QueryResult } from './types';
import type { Column } from '@dbstudio/erd';

export interface DataRow {
  /** Raw row indexed by column position; mirrors QueryResult.rows. */
  values: unknown[];
  /** Cached PK signature — concatenated PK column values joined by a
   *  sentinel. Used as a Map key for O(1) source↔target alignment. */
  key: string;
}

export interface CellChange {
  column: string;
  source: unknown;
  target: unknown;
}

export interface MismatchedRow {
  key: string;
  /** PK values in column order, for display + sync-SQL WHERE clauses. */
  pkValues: unknown[];
  sourceValues: unknown[];
  targetValues: unknown[];
  /** Only the columns whose values actually differ. The result grid
   *  highlights these; the sync-SQL emits SET only for these. */
  changes: CellChange[];
}

export interface DataDiffResult {
  /** Column order is the source's — sync SQL targets the source. */
  columns: string[];
  pkColumns: string[];
  /** Rows present on the source side but not on the target. */
  onlyInSource: DataRow[];
  /** Rows present on the target side but not on the source. */
  onlyInTarget: DataRow[];
  /** Rows present on both sides with at least one differing cell. */
  mismatched: MismatchedRow[];
  /** Total rows we considered on each side — surfaces the row-limit
   *  story so the UI can warn when a side hit the cap. */
  sourceCount: number;
  targetCount: number;
}

/** Sentinel for PK joining; \x1f (Unit Separator) is illegal in
 *  SQL identifiers and rare in real data, so collisions are
 *  vanishingly unlikely. */
const SEP = '\x1f';

/** Logical bucket we collapse every dialect's declared column type
 *  into. Drivers return the same logical value in different JS
 *  shapes (BIGINT-as-string vs INTEGER-as-number, DATETIME-as-ISO
 *  string vs Date object, TINYINT(1)-as-0/1 vs BOOLEAN-as-true/false),
 *  and a naive `===` comparison would falsely flag identical data
 *  as a mismatch every time. We classify the source column once,
 *  per engine, and then run a comparator that knows how to compare
 *  values of that shape. */
type LogicalType =
  | 'datetime'
  | 'numeric'
  | 'boolean'
  | 'json'
  | 'binary'
  | 'text';

/** Classify a declared column type into a LogicalType using engine-
 *  specific cues. We do prefix/keyword matching rather than enum-
 *  matching because each engine surfaces type names slightly
 *  differently (`integer` vs `int4` vs `INT(11)`) and the cues
 *  overlap cleanly. */
function classifyColumn(dataType: string, engine: DatabaseEngine): LogicalType {
  const t = dataType.toLowerCase().trim();

  // Datetime family — PG `timestamp{tz}` / `date` / `time` /
  // `interval`, MySQL `datetime` / `timestamp` / `date` / `time` /
  // `year`, SQLite stores these as TEXT but `datetime` is a common
  // declared affinity.
  if (
    t.startsWith('timestamp') ||
    t.startsWith('datetime') ||
    t === 'date' ||
    t === 'time' ||
    t.startsWith('time ') ||
    t === 'year' ||
    t === 'interval' ||
    t.startsWith('timetz') ||
    t.startsWith('time with')
  ) {
    return 'datetime';
  }

  // Boolean — PG `boolean`/`bool`, MySQL `tinyint(1)` is the de
  // facto bool surface (`BOOL` / `BOOLEAN` are TINYINT(1) aliases),
  // SQLite stores as INTEGER 0/1.
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (engine === 'mysql' && t === 'tinyint(1)') {
    return 'boolean';
  }

  // JSON / JSONB. PG has both; MySQL has `json`; SQLite uses
  // `json` as a declared affinity (stored as TEXT but apps tag it).
  if (t === 'json' || t === 'jsonb') return 'json';

  // Binary — PG `bytea`, MySQL `blob` / `varbinary` /
  // `binary` / `tinyblob` etc., SQLite `blob`. We compare as
  // strings since drivers emit hex / base64; downstream callers
  // can pretty-print.
  if (
    t === 'bytea' ||
    t.includes('blob') ||
    t.startsWith('binary') ||
    t.startsWith('varbinary')
  ) {
    return 'binary';
  }

  // Numeric — every engine's int family + float family + arbitrary-
  // precision decimal/numeric. We test on broad keywords because of
  // size variants (`int4`, `int8`, `bigint`, `smallint`, `tinyint`,
  // `mediumint`) and aliases (`integer`/`int`, `numeric`/`decimal`,
  // `real`/`float4`, `double precision`/`float8`).
  if (
    t.includes('int') ||
    t.startsWith('float') ||
    t.startsWith('real') ||
    t.startsWith('double') ||
    t.startsWith('numeric') ||
    t.startsWith('decimal') ||
    t === 'number' ||
    t.startsWith('serial') ||
    t === 'money'
  ) {
    return 'numeric';
  }

  return 'text';
}

/** Coerce a value into a `Date`, if it's a plausible datetime.
 *  Accepts JS `Date`, ISO strings (with or without `T`, with or
 *  without timezone), and MySQL-style `YYYY-MM-DD HH:MM:SS`. Returns
 *  null on anything else so the caller can fall back to string compare. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  // Be permissive but bounded — only attempt the parse when the
  // string at least starts with a date-shaped prefix. Stops
  // accidental hits on arbitrary strings that Date() would coerce.
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  // MySQL produces `2026-06-05 07:15:00` without a `T`; JS's Date
  // constructor accepts both forms but is more lenient when we
  // normalize. The `Z` fallback handles strings that omit any
  // timezone, treating them as UTC — same instant either way for
  // an UPDATE-equality check.
  const normalized = v.replace(' ', 'T');
  const d = new Date(/[+\-Z]\d{0,4}$|Z$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toBool(v: unknown): boolean | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase().trim();
    if (s === 'true' || s === 't' || s === '1' || s === 'yes' || s === 'y') return true;
    if (s === 'false' || s === 'f' || s === '0' || s === 'no' || s === 'n') return false;
  }
  return null;
}

/** Normalize a decimal/numeric string by stripping trailing zeros
 *  after the decimal point, leading zeros before, and a redundant
 *  leading `+`. Drops the decimal point if nothing remains after
 *  trimming. Lets PG `numeric` strings like `100.00` align with
 *  MySQL `decimal` strings like `100`. */
function normalizeNumericString(s: string): string {
  const t = s.trim();
  if (t === '') return t;
  const neg = t.startsWith('-');
  let body = neg ? t.slice(1) : t.startsWith('+') ? t.slice(1) : t;
  if (!/^\d+(?:\.\d+)?$/.test(body)) return s;
  if (body.includes('.')) {
    body = body.replace(/0+$/, '').replace(/\.$/, '');
  }
  body = body.replace(/^0+(?=\d)/, '');
  if (body === '' || body === '.') body = '0';
  return neg && body !== '0' ? `-${body}` : body;
}

/** Canonical string form of a value for use as a Map key (PK
 *  alignment) or for use as the equality form of a non-PK cell.
 *  Driven by the LogicalType so the same instant / same numeric /
 *  same boolean / same JSON produces the same key regardless of
 *  the driver-emitted JS shape. */
function normalizeValue(v: unknown, logical: LogicalType): string {
  if (v === null || v === undefined) return '\0NULL';
  switch (logical) {
    case 'datetime': {
      const d = toDate(v);
      if (d) return d.toISOString();
      return String(v).trim();
    }
    case 'boolean': {
      const b = toBool(v);
      if (b == null) return '\0NULL';
      return b ? '\0TRUE' : '\0FALSE';
    }
    case 'numeric': {
      // Prefer string-based normalization so big-int values that
      // overflow JS `number` stay precise (PG numerics, MySQL bigints).
      if (typeof v === 'number') {
        return Number.isFinite(v) ? normalizeNumericString(String(v)) : '\0NaN';
      }
      if (typeof v === 'string') return normalizeNumericString(v);
      return String(v);
    }
    case 'json': {
      try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        return JSON.stringify(parsed);
      } catch {
        return typeof v === 'string' ? v : JSON.stringify(v);
      }
    }
    case 'binary': {
      // Binary values arrive as base64 or hex strings depending on
      // the driver; normalize to lowercase hex if it looks hex,
      // otherwise leave as-is. Cross-driver binary equality across
      // engines is best-effort.
      const s = typeof v === 'string' ? v : String(v);
      return /^[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s;
    }
    case 'text':
    default: {
      // Even text columns get the number-string canonicalisation
      // (an `id` column declared as TEXT in SQLite still holds
      // numeric-looking values), so a no-op MySQL-source ↔
      // SQLite-target won't false-flag a row.
      if (typeof v === 'number') return String(v);
      if (typeof v === 'string') {
        const n = Number(v);
        if (v !== '' && Number.isFinite(n) && String(n) === v.trim()) {
          return String(n);
        }
        return v;
      }
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'object') {
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      }
      return String(v);
    }
  }
}

function rowKey(
  row: unknown[],
  pkPositions: number[],
  pkLogicals: LogicalType[],
): string {
  return pkPositions
    .map((i, idx) => normalizeValue(row[i], pkLogicals[idx] ?? 'text'))
    .join(SEP);
}

/** Engine + column-aware cell equality. We normalize each side to
 *  the column's LogicalType canonical form and string-compare. */
function cellsEqual(
  a: unknown,
  b: unknown,
  logical: LogicalType,
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return normalizeValue(a, logical) === normalizeValue(b, logical);
}

export interface DiffOptions {
  /** Source connection's engine. Drives column-type classification —
   *  same declared type name can mean different things across
   *  engines (`tinyint(1)` is boolean in MySQL but plain numeric in
   *  Postgres-ish dialects). */
  engine: DatabaseEngine;
  /** Source-table column metadata, used for type-aware comparison.
   *  When a column from the result isn't in this list (e.g. a
   *  generated alias) we fall back to text comparison. */
  schemaColumns: Column[];
}

/**
 * Compute the diff between two result sets aligned by primary key.
 * Both sides must share the same column set and order; the caller
 * generates the same `SELECT cols... FROM table ORDER BY pk` against
 * each connection to guarantee that. Cell comparison is engine- +
 * column-type aware so a value like `42` (number) on one side and
 * `"42"` (string) on the other doesn't false-report as a mismatch
 * when the column is numeric; same for ISO-vs-MySQL datetime
 * representations, TINYINT(1)-vs-BOOLEAN booleans, and so on.
 *
 * Throws when the PK columns aren't all present in the result —
 * we'd otherwise silently mismatch rows with NULL keys.
 */
export function diffData(
  source: QueryResult,
  target: QueryResult,
  pkColumns: string[],
  options: DiffOptions,
): DataDiffResult {
  const cols = source.columns.map((c) => c.name);
  const pkPositions = pkColumns.map((pk) => {
    const idx = cols.indexOf(pk);
    if (idx < 0) {
      throw new Error(
        `PK column "${pk}" missing from the result set — diff aligned by PK requires every PK column in SELECT`,
      );
    }
    return idx;
  });

  // Per-column LogicalType lookup, computed once. Schema metadata is
  // authoritative — fall back to `text` only when the result has a
  // column the schema doesn't know about (generated expressions,
  // SELECT * mid-migration, etc.).
  const colByName = new Map(options.schemaColumns.map((c) => [c.name, c]));
  const logicals: LogicalType[] = cols.map((c) => {
    const meta = colByName.get(c);
    return meta ? classifyColumn(meta.data_type, options.engine) : 'text';
  });
  const pkLogicals = pkPositions.map((i) => logicals[i] ?? 'text');

  const sourceMap = new Map<string, unknown[]>();
  for (const row of source.rows) {
    sourceMap.set(rowKey(row, pkPositions, pkLogicals), row);
  }
  const targetMap = new Map<string, unknown[]>();
  for (const row of target.rows) {
    targetMap.set(rowKey(row, pkPositions, pkLogicals), row);
  }

  const onlyInSource: DataRow[] = [];
  const mismatched: MismatchedRow[] = [];
  for (const [key, sRow] of sourceMap) {
    const tRow = targetMap.get(key);
    if (!tRow) {
      onlyInSource.push({ values: sRow, key });
      continue;
    }
    const changes: CellChange[] = [];
    for (let i = 0; i < cols.length; i++) {
      const colName = cols[i];
      if (colName == null) continue;
      if (!cellsEqual(sRow[i], tRow[i], logicals[i] ?? 'text')) {
        changes.push({ column: colName, source: sRow[i], target: tRow[i] });
      }
    }
    if (changes.length > 0) {
      mismatched.push({
        key,
        pkValues: pkPositions.map((i) => sRow[i]),
        sourceValues: sRow,
        targetValues: tRow,
        changes,
      });
    }
  }

  const onlyInTarget: DataRow[] = [];
  for (const [key, tRow] of targetMap) {
    if (!sourceMap.has(key)) {
      onlyInTarget.push({ values: tRow, key });
    }
  }

  return {
    columns: cols,
    pkColumns,
    onlyInSource,
    onlyInTarget,
    mismatched,
    sourceCount: source.rows.length,
    targetCount: target.rows.length,
  };
}

/** Engines we'll permit for data diff. NoSQL engines are excluded
 *  because their row model isn't relational; relational ones all
 *  pass. The UI uses this to disable the target picker entries
 *  that don't match the source engine. */
export function engineCanDiff(engine: string): boolean {
  return engine === 'postgres' || engine === 'mysql' || engine === 'sqlite';
}
