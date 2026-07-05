'use client';

// Data diff panel — the streamlined version.
//
// Instead of the old page's 4-tab drill-down (Only in source /
// Mismatched / Only in target / Sync SQL) with an Apply button
// buried under the last tab, this panel surfaces the important
// numbers up front and lets the user apply the whole sync with one
// click. Details are behind expandable rows for anyone who needs to
// audit before applying.
//
// Click reduction path for the common case:
//   old:  pick src → pick tgt → pick src table → pick tgt table →
//         cap → compute → tab-through-4-tabs → apply     (~9 clicks)
//   new:  pick src → pick tgt → pick table (auto-match) → apply
//                                                        (~4 clicks)

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Play,
  Rows3,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useSchemaCache } from '@/store/schemaCache';
import { useServerInfoCache } from '@/store/serverInfoCache';
import { useMigrationLog, type MigrationStatement } from '@/store/migrationLog';
import { api } from '@/lib/api';
import { quoteIdent, quoteStyleForEngine } from '@/lib/sqlIdent';
import { diffData, engineCanDiff, type DataDiffResult } from '@/lib/dataDiff';
import { buildSyncStatements } from '@/lib/dataDiffSql';
import type { ConnectionProfile } from '@/lib/types';
import type { Schema, Table } from '@dbstudio/erd';
import { cn } from '@/lib/utils';

const DEFAULT_ROW_CAP = 10_000;

interface Props {
  source: ConnectionProfile | undefined;
  target: ConnectionProfile | undefined;
}

interface FlatTable {
  schema: string;
  name: string;
  full: string;
  table: Table;
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; diff: DataDiffResult }
  | { kind: 'error'; message: string };

export function DataDiffPanel({ source, target }: Props) {
  const loadSchema = useSchemaCache((s) => s.load);
  const loadServerInfo = useServerInfoCache((s) => s.load);
  const serverInfoBy = useServerInfoCache((s) => s.entries);

  const [sourceSchemas, setSourceSchemas] = useState<Schema | null>(null);
  const [targetSchemas, setTargetSchemas] = useState<Schema | null>(null);
  const [tableRef, setTableRef] = useState('');
  const [rowCap, setRowCap] = useState<number>(DEFAULT_ROW_CAP);
  const [direction, setDirection] = useState<
    'source-to-target' | 'target-to-source'
  >('source-to-target');
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const engineSupported = source ? engineCanDiff(source.engine) : false;
  const enginesMatch =
    source && target && source.engine === target.engine;

  // Load both schemas + server info in parallel when connections
  // change. Cached, so re-picks are instant.
  useEffect(() => {
    if (!source) {
      setSourceSchemas(null);
      return;
    }
    void loadSchema(source).then(setSourceSchemas).catch(() => setSourceSchemas(null));
    void loadServerInfo(source);
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!target) {
      setTargetSchemas(null);
      return;
    }
    void loadSchema(target).then(setTargetSchemas).catch(() => setTargetSchemas(null));
    void loadServerInfo(target);
  }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const sourceTables = useMemo(
    () => (sourceSchemas ? flattenTables(sourceSchemas) : []),
    [sourceSchemas],
  );
  const targetTablesSet = useMemo(() => {
    const s = new Set<string>();
    if (targetSchemas) {
      for (const t of flattenTables(targetSchemas)) s.add(t.full);
    }
    return s;
  }, [targetSchemas]);

  // Only offer tables that exist on BOTH sides — anything else can't
  // be diffed.
  const commonTables = useMemo(
    () => sourceTables.filter((t) => targetTablesSet.has(t.full)),
    [sourceTables, targetTablesSet],
  );

  // Auto-select the first common table on connection change if none
  // is currently picked.
  useEffect(() => {
    if (!tableRef && commonTables.length > 0) {
      setTableRef(commonTables[0]!.full);
    }
  }, [commonTables, tableRef]);

  const activeTable = commonTables.find((t) => t.full === tableRef) ?? null;

  // Auto-compute when everything's ready: source + target picked,
  // engines match, table picked, table has a PK.
  useEffect(() => {
    setApplied(false);
    setApplyError(null);
    if (
      !source ||
      !target ||
      !enginesMatch ||
      !engineSupported ||
      !activeTable ||
      !activeTable.table.primary_key ||
      activeTable.table.primary_key.columns.length === 0
    ) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    void (async () => {
      try {
        const pkColumns = activeTable.table.primary_key!.columns;
        const sql = buildOrderedSelect(
          source.engine,
          activeTable,
          pkColumns,
          rowCap,
        );
        const sqlTarget = buildOrderedSelect(
          target.engine,
          activeTable,
          pkColumns,
          rowCap,
        );
        const [s, t] = await Promise.all([
          api.runQuery(source, { sql }),
          api.runQuery(target, { sql: sqlTarget }),
        ]);
        if (cancelled) return;
        const diff = diffData(s, t, pkColumns, {
          engine: source.engine,
          schemaColumns: activeTable.table.columns,
        });
        setLoad({ kind: 'ok', diff });
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { code?: string; message?: string };
        setLoad({
          kind: 'error',
          message: `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    source?.id,
    target?.id,
    activeTable?.full,
    rowCap,
    direction,
    enginesMatch,
    engineSupported,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const sync = useMemo(() => {
    if (load.kind !== 'ok' || !source || !activeTable) return null;
    const writeProfile = direction === 'source-to-target' ? source : target;
    const writeVersion = writeProfile
      ? serverInfoBy[writeProfile.id]?.version ?? undefined
      : undefined;
    return buildSyncStatements(
      source.engine,
      activeTable.schema,
      activeTable.name,
      load.diff,
      { direction, writeSideVersion: writeVersion },
    );
  }, [load, source, target, activeTable, direction, serverInfoBy]);

  const totalStatements = useMemo(() => {
    if (!sync) return 0;
    return sync.inserts.length + sync.updates.length + sync.deletes.length;
  }, [sync]);

  const writeSide = direction === 'source-to-target' ? source : target;

  const recordMigration = useMigrationLog((s) => s.record);

  const applyAll = async () => {
    if (!sync || !writeSide || !activeTable || !source) return;
    setApplying(true);
    setApplyError(null);

    // Order matters for cross-row FK safety even within a single
    // table (self-references) and across future multi-table apply:
    //   1. INSERTs   — parent rows first so children can reference
    //   2. UPDATEs   — any order (already keyed by PK)
    //   3. DELETEs   — children first so parents can be dropped safely
    // The current UI is single-table so the practical effect is:
    // do all INSERTs, then UPDATEs, then DELETEs. This is the same
    // order buildSyncStatements returns them in, so we just concat.
    const statements = [...sync.inserts, ...sync.updates, ...sync.deletes];

    let batch: Awaited<ReturnType<typeof api.applyBatch>>;
    try {
      batch = await api.applyBatch(writeSide, statements);
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      const msg = `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`;
      setApplyError(msg);
      setApplying(false);
      recordMigration({
        kind: 'data',
        sourceConnectionId: writeSide.id,
        sourceConnectionName: writeSide.name,
        targetConnectionId: writeSide === source ? target?.id ?? null : source.id,
        targetConnectionName:
          writeSide === source ? target?.name ?? null : source.name,
        engine: writeSide.engine,
        committed: false,
        summary: `apply_batch call failed: ${msg}`,
        label: `Data sync · ${activeTable.full}`,
        statements: statements.map((sql) => ({
          sql,
          outcome: { kind: 'fail', error: msg },
        })),
      });
      return;
    }

    const migrationStatements: MigrationStatement[] = batch.statements.map(
      (s, i) => {
        const sql = statements[i]!;
        if (s.outcome.kind === 'ok') {
          return {
            sql,
            outcome: { kind: 'ok', rowsAffected: s.outcome.rows_affected ?? null },
          };
        }
        if (s.outcome.kind === 'fail') {
          return { sql, outcome: { kind: 'fail', error: s.outcome.error } };
        }
        return { sql, outcome: { kind: 'skipped' } };
      },
    );

    recordMigration({
      kind: 'data',
      sourceConnectionId: writeSide.id,
      sourceConnectionName: writeSide.name,
      targetConnectionId: writeSide === source ? target?.id ?? null : source.id,
      targetConnectionName:
        writeSide === source ? target?.name ?? null : source.name,
      engine: writeSide.engine,
      committed: batch.committed,
      summary: batch.summary,
      label: `Data sync · ${activeTable.full}`,
      statements: migrationStatements,
    });

    if (!batch.committed) {
      const failed = batch.statements.find((s) => s.outcome.kind === 'fail');
      setApplyError(
        failed && failed.outcome.kind === 'fail'
          ? failed.outcome.error
          : batch.summary,
      );
    } else {
      setApplied(true);
    }
    setApplying(false);
  };

  const copyAll = async () => {
    if (!sync) return;
    const all = [...sync.inserts, ...sync.updates, ...sync.deletes];
    if (all.length === 0) return;
    await navigator.clipboard.writeText(all.join('\n\n')).catch(() => {});
  };

  if (!source || !target) {
    return (
      <EmptyMessage>Pick a source and target connection to compare.</EmptyMessage>
    );
  }
  if (!enginesMatch) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
        Data diff is only supported when both connections share an engine.
      </div>
    );
  }
  if (!engineSupported) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
        Data diff isn&apos;t available for this engine.
      </div>
    );
  }
  if (commonTables.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        {sourceSchemas && targetSchemas
          ? 'No tables shared between the two connections.'
          : 'Loading tables…'}
      </div>
    );
  }

  const tableOptions: ComboboxOption[] = commonTables.map((t) => ({
    value: t.full,
    label: t.full,
    keywords: [t.schema, t.name],
  }));

  return (
    <div className="space-y-4">
      {/* Table + direction + row-cap row. All auto-compute triggers. */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Table
          </span>
          <div className="w-72">
            <Combobox
              value={tableRef}
              onChange={setTableRef}
              options={tableOptions}
              placeholder="pick a table"
              emptyLabel="No shared tables"
            />
          </div>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Direction
          </span>
          <DirectionToggle
            direction={direction}
            onChange={setDirection}
            source={source}
            target={target}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Row cap
          </span>
          <select
            value={rowCap}
            onChange={(e) => setRowCap(Number(e.target.value))}
            className="rounded border bg-background px-2 py-1.5 text-sm"
          >
            {[1_000, 10_000, 100_000, 1_000_000].map((n) => (
              <option key={n} value={n}>
                {n.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      </div>

      {activeTable && !activeTable.table.primary_key && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
          <span className="font-medium">{activeTable.full}</span> has no
          primary key. Data diff needs a PK to align rows.
        </div>
      )}

      {load.kind === 'loading' && (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading rows from both sides…
        </div>
      )}
      {load.kind === 'error' && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="mr-1 inline h-3 w-3" />
          {load.message}
        </div>
      )}

      {load.kind === 'ok' && sync && (
        <>
          <StatsGrid diff={load.diff} sync={sync} />

          <details className="group rounded-lg border bg-card">
            <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:bg-accent/40">
              <ChevronRight className="h-3 w-3 transition group-open:rotate-90" />
              Preview generated SQL
              <span className="ml-auto font-mono text-[10px]">
                {totalStatements} statement{totalStatements === 1 ? '' : 's'}
              </span>
            </summary>
            <div className="border-t p-3">
              <SqlPreview sync={sync} />
            </div>
          </details>

          <div className="flex items-center justify-between gap-3 rounded-xl border bg-card/95 p-3 shadow-sm">
            <div className="text-sm">
              {applied ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  Applied {totalStatements} statement
                  {totalStatements === 1 ? '' : 's'} against{' '}
                  <span className="font-medium">{writeSide?.name}</span>.
                </span>
              ) : applyError ? (
                <span className="inline-flex items-center gap-1.5 text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {applyError}
                </span>
              ) : (
                <>
                  <span className="font-medium">{totalStatements}</span>{' '}
                  <span className="text-muted-foreground">
                    statement{totalStatements === 1 ? '' : 's'} to run against{' '}
                    <span className="font-medium">{writeSide?.name}</span>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={copyAll}
                disabled={totalStatements === 0}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy all
              </Button>
              <Button
                size="sm"
                onClick={applyAll}
                disabled={applying || totalStatements === 0 || applied}
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Apply all
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Sub-components ------------------------------------------------

function StatsGrid({
  diff,
  sync,
}: {
  diff: DataDiffResult;
  sync: ReturnType<typeof buildSyncStatements>;
}) {
  const cells = [
    {
      label: 'Only in source',
      value: diff.onlyInSource.length,
      color: 'text-sky-700 dark:text-sky-300',
    },
    {
      label: 'Only in target',
      value: diff.onlyInTarget.length,
      color: 'text-amber-700 dark:text-amber-300',
    },
    {
      label: 'Mismatched',
      value: diff.mismatched.length,
      color: 'text-rose-700 dark:text-rose-300',
    },
    {
      label: 'INSERTs',
      value: sync.inserts.length,
      color: 'text-emerald-700 dark:text-emerald-400',
    },
    {
      label: 'UPDATEs',
      value: sync.updates.length,
      color: 'text-amber-700 dark:text-amber-300',
    },
    {
      label: 'DELETEs',
      value: sync.deletes.length,
      color: 'text-destructive',
    },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border bg-card p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {c.label}
          </p>
          <p className={cn('mt-0.5 text-lg font-semibold tabular-nums', c.color)}>
            {c.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function SqlPreview({
  sync,
}: {
  sync: ReturnType<typeof buildSyncStatements>;
}) {
  const all = [
    ...sync.inserts.map((s) => ({ kind: 'INSERT', sql: s })),
    ...sync.updates.map((s) => ({ kind: 'UPDATE', sql: s })),
    ...sync.deletes.map((s) => ({ kind: 'DELETE', sql: s })),
  ];
  if (all.length === 0) {
    return <p className="text-xs text-muted-foreground">No statements — rows are in sync.</p>;
  }
  const displayCap = 50;
  const truncated = all.length > displayCap;
  const visible = all.slice(0, displayCap);
  return (
    <div className="space-y-1">
      {visible.map((row, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px]">
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold',
              row.kind === 'INSERT' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
              row.kind === 'UPDATE' && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
              row.kind === 'DELETE' && 'bg-destructive/10 text-destructive',
            )}
          >
            {row.kind}
          </span>
          <code className="flex-1 truncate font-mono">{row.sql}</code>
        </div>
      ))}
      {truncated && (
        <p className="pt-2 text-[10px] text-muted-foreground">
          Showing first {displayCap} of {all.length} statements. Use “Copy all” to
          see everything.
        </p>
      )}
    </div>
  );
}

function DirectionToggle({
  direction,
  onChange,
  source,
  target,
}: {
  direction: 'source-to-target' | 'target-to-source';
  onChange: (d: 'source-to-target' | 'target-to-source') => void;
  source: ConnectionProfile;
  target: ConnectionProfile;
}) {
  return (
    <div className="inline-flex rounded-md border bg-background p-0.5 text-[11px]">
      <button
        type="button"
        onClick={() => onChange('source-to-target')}
        className={cn(
          'rounded px-2.5 py-1 transition',
          direction === 'source-to-target'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {truncate(source.name)} → {truncate(target.name)}
      </button>
      <button
        type="button"
        onClick={() => onChange('target-to-source')}
        className={cn(
          'rounded px-2.5 py-1 transition',
          direction === 'target-to-source'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        {truncate(target.name)} → {truncate(source.name)}
      </button>
    </div>
  );
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 rounded-lg border bg-card p-8 text-sm text-muted-foreground">
      <Rows3 className="h-4 w-4" />
      {children}
    </div>
  );
}

// --- Helpers -------------------------------------------------------

function flattenTables(schema: Schema): FlatTable[] {
  const out: FlatTable[] = [];
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      out.push({
        schema: t.schema || ns.name,
        name: t.name,
        full: `${t.schema || ns.name}.${t.name}`,
        table: t,
      });
    }
  }
  return out;
}

function buildOrderedSelect(
  engine: string,
  t: FlatTable,
  pkColumns: string[],
  rowCap: number,
): string {
  const style = quoteStyleForEngine(engine as never);
  const cols = t.table.columns.map((c) => quoteIdent(c.name, style)).join(', ');
  const pkList = pkColumns.map((c) => quoteIdent(c, style)).join(', ');
  const ref =
    engine === 'sqlite'
      ? quoteIdent(t.name, style)
      : `${quoteIdent(t.schema, style)}.${quoteIdent(t.name, style)}`;
  return `SELECT ${cols} FROM ${ref} ORDER BY ${pkList} LIMIT ${rowCap};`;
}

function truncate(s: string, max = 16): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
