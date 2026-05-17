// Result-grid exporters. Convert rows + columns to CSV / JSON / SQL INSERT.
// Triggered via Blob + temporary `<a download>` so the OS save dialog handles
// the destination — works the same in Tauri's WKWebView and a real browser.

import type { ResultColumn } from './types';

export type ExportFormat = 'csv' | 'json' | 'sql';

interface ExportInput {
  columns: ResultColumn[];
  rows: unknown[][];
  /** Used as fallback filename stem and (for SQL) as the INSERT INTO target. */
  baseName: string;
}

/** RFC 4180 quoting: wrap in double quotes if the field contains comma,
 *  double-quote, or newline; double up internal quotes. NULL → empty field. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV({ columns, rows }: { columns: ResultColumn[]; rows: unknown[][] }): string {
  const header = columns.map((c) => csvField(c.name)).join(',');
  const body = rows.map((r) => r.map(csvField).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

export function toJSON({ columns, rows }: { columns: ResultColumn[]; rows: unknown[][] }): string {
  const objects = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      obj[c.name] = r[i];
    });
    return obj;
  });
  return JSON.stringify(objects, null, 2);
}

/** SQL string literal: wrap in single quotes, double up internal ones. */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${s.replace(/'/g, "''")}'`;
}

/** Identifier quoting — double-quote and double up internal quotes.
 *  Works for Postgres/SQLite; MySQL accepts double-quote idents when
 *  ANSI_QUOTES is enabled, which is the safe default these days. Users can
 *  hand-edit if they need backticks. */
function sqlIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function toSQL({
  columns,
  rows,
  tableName,
}: {
  columns: ResultColumn[];
  rows: unknown[][];
  tableName: string;
}): string {
  const cols = columns.map((c) => sqlIdent(c.name)).join(', ');
  const target = sqlIdent(tableName);
  const lines = rows.map((r) => {
    const values = r.map(sqlLiteral).join(', ');
    return `INSERT INTO ${target} (${cols}) VALUES (${values});`;
  });
  return lines.join('\n') + '\n';
}

export function downloadText(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: mime });
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
      downloadText(`${base}-${stamp}.csv`, 'text/csv;charset=utf-8', toCSV(input));
      return;
    case 'json':
      downloadText(`${base}-${stamp}.json`, 'application/json', toJSON(input));
      return;
    case 'sql': {
      const tableName =
        typeof window !== 'undefined'
          ? window.prompt('Table name for INSERT statements:', base)
          : base;
      if (!tableName) return;
      downloadText(
        `${base}-${stamp}.sql`,
        'application/sql',
        toSQL({ ...input, tableName }),
      );
      return;
    }
  }
}
