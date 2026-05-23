'use client';

// Bulk row insert via pasted CSV. Loops the existing single-row insert
// endpoint — keeps the backend surface tiny, accepts one round-trip per
// row. For interactive bulk-paste (~tens to hundreds of rows) that's
// fine; bulk-loading millions of rows is a separate problem.

import { useMemo, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Column as SchemaColumn } from '@dbstudio/erd';
import type { ConnectionProfile } from '@/lib/types';
import { api } from '@/lib/api';
import { parseCsv } from '@/lib/parseCsv';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: ConnectionProfile;
  schema: string;
  table: string;
  columns: SchemaColumn[];
  /** Called after at least one row was inserted (even on partial
   *  failure) so the parent can refetch the grid. */
  onChanged?: () => void;
}

/** Sentinel value for "skip this CSV column" in the mapping <select>.
 *  Empty string would collide with HTML semantics; `__skip__` is
 *  reserved enough that no real column will ever match. */
const SKIP = '__skip__';

export function BulkInsertDialog({
  open,
  onOpenChange,
  profile,
  schema,
  table,
  columns,
  onChanged,
}: Props) {
  const [text, setText] = useState('');
  const [hasHeader, setHasHeader] = useState(true);
  /** Per-source-column → target table column (or SKIP). When the user
   *  hasn't touched the dropdown we leave it at the auto-detected value
   *  derived from the CSV header row. */
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseCsv(text), [text]);
  const headerRow = hasHeader ? parsed.rows[0] : null;
  const dataRows = hasHeader ? parsed.rows.slice(1) : parsed.rows;

  /** Auto-map CSV columns to table columns by name (case-insensitive),
   *  unless the user has explicitly set a mapping. Pure derived state so
   *  it stays correct when the user toggles the header flag or pastes
   *  new CSV. */
  const effectiveMapping = useMemo(() => {
    const out: Record<number, string> = {};
    const colNames = new Map(columns.map((c) => [c.name.toLowerCase(), c.name]));
    const sourceCount = headerRow?.length ?? parsed.rows[0]?.length ?? 0;
    for (let i = 0; i < sourceCount; i++) {
      if (mapping[i] !== undefined) {
        out[i] = mapping[i]!;
        continue;
      }
      const head = headerRow?.[i];
      if (head && colNames.has(head.toLowerCase())) {
        out[i] = colNames.get(head.toLowerCase())!;
      } else {
        out[i] = SKIP;
      }
    }
    return out;
  }, [mapping, headerRow, parsed.rows, columns]);

  const sourceCount = headerRow?.length ?? parsed.rows[0]?.length ?? 0;
  const includedTargets = Object.values(effectiveMapping).filter((v) => v !== SKIP);
  const ready = dataRows.length > 0 && includedTargets.length > 0 && !applying;

  const reset = () => {
    setText('');
    setHasHeader(true);
    setMapping({});
    setApplying(false);
    setProgress(null);
    setError(null);
  };

  const apply = async () => {
    setError(null);
    setApplying(true);
    setProgress({ done: 0, total: dataRows.length });
    let succeeded = 0;
    try {
      for (const row of dataRows) {
        const values: Array<[string, unknown]> = [];
        for (let i = 0; i < sourceCount; i++) {
          const target = effectiveMapping[i];
          if (!target || target === SKIP) continue;
          // Empty cells become NULL — same convention as the single-row
          // insert dialog. The DB will reject NULLs on NOT-NULL columns
          // with no default and the user sees the error.
          const raw = row[i] ?? '';
          values.push([target, raw === '' ? null : coerceFromString(raw, target, columns)]);
        }
        if (values.length === 0) continue;
        const affected = await api.insertRow(profile, { schema, table, values });
        if (affected !== 1) {
          throw {
            code: 'unexpected_rows',
            message: `Expected 1 row affected, got ${affected}.`,
          };
        }
        succeeded++;
        setProgress({ done: succeeded, total: dataRows.length });
      }
      onChanged?.();
      onOpenChange(false);
      // Defer reset so the dialog's close animation doesn't see empty
      // state mid-fade.
      setTimeout(reset, 200);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setError(
        `Inserted ${succeeded}/${dataRows.length} rows. Last failure: ${err.code ?? 'unknown'} · ${err.message ?? String(e)}`,
      );
      if (succeeded > 0) onChanged?.();
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && applying) return; // don't allow closing mid-apply
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" />
            Bulk insert rows
          </DialogTitle>
          <DialogDescription>
            Paste CSV below. Each non-header line becomes one INSERT
            statement looped against the live database. Empty cells go
            in as NULL.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'id,name,age\n1,alice,30\n2,bob,28'}
            className="scrollbar-thin h-32 w-full resize-y rounded border border-input bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            disabled={applying}
          />

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(e) => setHasHeader(e.target.checked)}
              disabled={applying}
            />
            First row is a header
          </label>

          {sourceCount > 0 && (
            <div className="rounded border">
              <div className="border-b bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Column mapping
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {Array.from({ length: sourceCount }).map((_, i) => (
                    <tr key={i} className="border-b last:border-b-0">
                      <td className="px-2 py-1 font-mono text-muted-foreground">
                        {headerRow?.[i] ?? `column ${i + 1}`}
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">→</td>
                      <td className="w-1/2 px-2 py-1">
                        <select
                          value={effectiveMapping[i] ?? SKIP}
                          onChange={(e) =>
                            setMapping((prev) => ({ ...prev, [i]: e.target.value }))
                          }
                          disabled={applying}
                          className="w-full rounded border border-input bg-background px-1 py-0.5 font-mono text-xs"
                        >
                          <option value={SKIP}>— skip —</option>
                          {columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name}
                              {!c.nullable && c.default == null ? ' (required)' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {dataRows.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {dataRows.length} row{dataRows.length === 1 ? '' : 's'} to
              insert · {includedTargets.length} column
              {includedTargets.length === 1 ? '' : 's'} mapped
            </p>
          )}

          {progress && applying && (
            <p className="text-[11px] text-muted-foreground">
              Inserting… {progress.done}/{progress.total}
            </p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={applying}
          >
            Cancel
          </Button>
          <Button onClick={apply} disabled={!ready}>
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            Insert {dataRows.length} row{dataRows.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Light type-aware coercion of a CSV string cell into the JS value the
 *  driver binds. Mirrors the single-row insert dialog's coercion but
 *  works off the column metadata directly (since there's no per-field
 *  draft state here). Numeric columns get parsed; bools get parsed;
 *  everything else stays a string for the driver to interpret. */
function coerceFromString(
  raw: string,
  columnName: string,
  columns: SchemaColumn[],
): unknown {
  const col = columns.find((c) => c.name === columnName);
  if (!col) return raw;
  const t = col.data_type.toLowerCase();
  if (/(int|serial|bigint|smallint|mediumint|tinyint)/.test(t)) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : raw;
  }
  if (/(numeric|decimal|real|double|float|money)/.test(t)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (/bool/.test(t)) {
    const v = raw.toLowerCase();
    if (v === 'true' || v === '1' || v === 't' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'f' || v === 'no') return false;
    return raw;
  }
  return raw;
}
