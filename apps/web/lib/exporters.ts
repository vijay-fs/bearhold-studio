// Result-grid exporters. Convert rows + columns to CSV / JSON / SQL INSERT.
//
// We build the export as an array of small string chunks (one per row,
// plus header/footer pieces) and hand it to `new Blob([...])` rather
// than concatenating the whole file into a single JS string first. V8
// caps individual strings at ~512 MB, and building megabyte-scale
// strings via `+=` triggers repeated reallocations — the chunked path
// stays flat-memory regardless of result-set size, so a million-row
// CSV export works without crashing the renderer. The Blob runtime
// concatenates internally as it streams the bytes to the file.

import type { DatabaseEngine, ResultColumn } from './types';
import { quoteIdent, quoteStyleForEngine } from './sqlIdent';
import { formatSqlLiteral } from './sqlLiteral';

export type ExportFormat = 'csv' | 'json' | 'sql';

interface ExportInput {
  columns: ResultColumn[];
  rows: unknown[][];
  /** Used as fallback filename stem and (for SQL) as the INSERT INTO target. */
  baseName: string;
  /** Drives SQL identifier quoting. Omit only when the engine is
   *  genuinely unknown (e.g. a cloud-exported result with no live
   *  profile); the SQL export then defaults to ANSI double-quotes. */
  engine?: DatabaseEngine;
}

/** RFC 4180 quoting: wrap in double quotes if the field contains comma,
 *  double-quote, or newline; double up internal quotes. NULL → empty field. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Chunked CSV writer — emits one string per row so the Blob constructor
 *  can stream them out without first materializing the whole file as a
 *  single in-memory string. The string returned for a row already has
 *  its trailing newline, so the Blob is just `[header, row, row, …]`. */
export function toCSVChunks({
  columns,
  rows,
}: {
  columns: ResultColumn[];
  rows: unknown[][];
}): string[] {
  const chunks: string[] = [];
  chunks.push(columns.map((c) => csvField(c.name)).join(',') + '\n');
  for (const r of rows) {
    chunks.push(r.map(csvField).join(',') + '\n');
  }
  return chunks;
}

/** Chunked JSON-array writer. Format mirrors a `JSON.stringify(arr, null, 2)`
 *  except we emit each object as its own string chunk, joined by commas
 *  and newlines. Order matters — `[`, first object, then for each
 *  subsequent `,\n` + object, finally `\n]`. */
export function toJSONChunks({
  columns,
  rows,
}: {
  columns: ResultColumn[];
  rows: unknown[][];
}): string[] {
  if (rows.length === 0) return ['[]'];
  const chunks: string[] = ['[\n'];
  for (let i = 0; i < rows.length; i++) {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, j) => {
      obj[c.name] = rows[i]![j];
    });
    chunks.push((i > 0 ? ',\n' : '') + '  ' + JSON.stringify(obj));
  }
  chunks.push('\n]');
  return chunks;
}

// SQL literal formatting moved to `lib/sqlLiteral.ts` — shared with
// the data-diff sync SQL emitter so the same engine-specific quirks
// (MySQL datetime format, backslash escapes) get fixed once.
const sqlLiteral = formatSqlLiteral;

/** Chunked SQL writer — one INSERT statement per chunk. The `engine`
 *  drives identifier quoting: backticks for MySQL, ANSI double-quotes
 *  for Postgres/SQLite. The previous version
 *  always emitted ANSI quotes which MySQL rejects unless `ANSI_QUOTES`
 *  is enabled — so a paste from one MySQL into another would fail
 *  with `you have an error in your SQL syntax near '"col_name"'`.
 *
 *  `engine` is optional so callers that genuinely don't know
 *  (cloud-side downloads with no live profile) still get a usable
 *  ANSI-quoted output. */
export function toSQLChunks({
  columns,
  rows,
  tableName,
  engine,
}: {
  columns: ResultColumn[];
  rows: unknown[][];
  tableName: string;
  engine?: DatabaseEngine;
}): string[] {
  const style = engine ? quoteStyleForEngine(engine) : 'ansi';
  const cols = columns.map((c) => quoteIdent(c.name, style)).join(', ');
  const target = quoteIdent(tableName, style);
  const chunks: string[] = [];
  for (const r of rows) {
    chunks.push(
      `INSERT INTO ${target} (${cols}) VALUES (${r
        .map((v) => sqlLiteral(v, engine))
        .join(', ')});\n`,
    );
  }
  return chunks;
}

/** Trigger a download given a Blob's worth of chunks. The OS save
 *  dialog handles the destination — works in Tauri's WKWebView and a
 *  real browser without needing any extra permissions. */
export function downloadChunks(
  filename: string,
  mime: string,
  chunks: string[],
): void {
  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportAs(format: ExportFormat, input: ExportInput): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = input.baseName.replace(/[^\w.-]+/g, '_') || 'export';
  switch (format) {
    case 'csv':
      downloadChunks(
        `${base}-${stamp}.csv`,
        'text/csv;charset=utf-8',
        toCSVChunks(input),
      );
      return;
    case 'json':
      downloadChunks(
        `${base}-${stamp}.json`,
        'application/json',
        toJSONChunks(input),
      );
      return;
    case 'sql': {
      const tableName =
        typeof window !== 'undefined'
          ? window.prompt('Table name for INSERT statements:', base)
          : base;
      if (!tableName) return;
      downloadChunks(
        `${base}-${stamp}.sql`,
        'application/sql',
        toSQLChunks({ ...input, tableName, engine: input.engine }),
      );
      return;
    }
  }
}
