'use client';

// Data-diff workspace. Pick two connections (must share an engine),
// pick one table from each, and compute an aligned row diff. The
// PK columns drive the alignment; tables without a PK are
// unsupported in v1 because their rows have no stable identity.
//
// Convention mirrors schema diff: source is the side we'll modify,
// target is the desired state. Sync SQL targets the source.

import { Suspense, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  Rows3,
  Play,
  Copy,
  ArrowRightLeft,
  Check,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { useServerInfoCache } from '@/store/serverInfoCache';
import { api } from '@/lib/api';
import {
  ENGINE_LABELS,
  type ConnectionProfile,
  type QueryResult,
} from '@/lib/types';
import type { Schema, Table } from '@dbstudio/erd';
import { quoteIdent, quoteStyleForEngine } from '@/lib/sqlIdent';
import {
  diffData,
  engineCanDiff,
  type DataDiffResult,
} from '@/lib/dataDiff';
import { buildSyncStatements } from '@/lib/dataDiffSql';
import { cn } from '@/lib/utils';

const DEFAULT_ROW_CAP = 10_000;

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; diff: DataDiffResult }
  | { kind: 'error'; code: string; message: string };

type ResultTab = 'inserts' | 'updates' | 'deletes' | 'sql';

function DataDiffInner() {
  const profiles = useConnections((s) => s.profiles);
  const loadSchema = useSchemaCache((s) => s.load);
  const loadServerInfo = useServerInfoCache((s) => s.load);
  const serverInfoBy = useServerInfoCache((s) => s.entries);

  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [sourceSchemas, setSourceSchemas] = useState<Schema | null>(null);
  const [targetSchemas, setTargetSchemas] = useState<Schema | null>(null);
  const [sourceTable, setSourceTable] = useState('');
  const [targetTable, setTargetTable] = useState('');
  const [rowCap, setRowCap] = useState(DEFAULT_ROW_CAP);
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [tab, setTab] = useState<ResultTab>('inserts');
  const [direction, setDirection] = useState<
    'source-to-target' | 'target-to-source'
  >('source-to-target');
  const [applyState, setApplyState] = useState<
    { kind: 'idle' } | { kind: 'applying' } | { kind: 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const sourceProfile = profiles.find((p) => p.id === sourceId);
  const targetProfile = profiles.find((p) => p.id === targetId);
  const enginesMatch =
    sourceProfile && targetProfile && sourceProfile.engine === targetProfile.engine;
  const engineSupported = sourceProfile
    ? engineCanDiff(sourceProfile.engine)
    : false;

  // Schemas are needed for the table picker on each side. We load
  // them lazily when the user selects a connection — the picker
  // can't render its options without the table list.
  useEffect(() => {
    if (!sourceProfile) {
      setSourceSchemas(null);
      setSourceTable('');
      return;
    }
    void loadSchema(sourceProfile)
      .then(setSourceSchemas)
      .catch(() => setSourceSchemas(null));
    // Warm the server-info cache so the sync-SQL memo has version
    // available by the time it fires. Errors (NoSQL Unsupported) are
    // swallowed inside the cache.
    void loadServerInfo(sourceProfile);
  }, [sourceProfile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!targetProfile) {
      setTargetSchemas(null);
      setTargetTable('');
      return;
    }
    void loadSchema(targetProfile)
      .then(setTargetSchemas)
      .catch(() => setTargetSchemas(null));
    void loadServerInfo(targetProfile);
  }, [targetProfile?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When source table changes, seed target table with the same name
  // if it exists on the target side — most diffs are "this table
  // here vs the same table there", so save the click.
  useEffect(() => {
    if (!sourceTable || !targetSchemas) return;
    const flat = flattenTables(targetSchemas);
    if (flat.some((t) => qualify(t) === sourceTable)) {
      setTargetTable(sourceTable);
    }
  }, [sourceTable, targetSchemas]);

  const sourceTableMeta = useMemo(
    () => findTable(sourceSchemas, sourceTable),
    [sourceSchemas, sourceTable],
  );
  const targetTableMeta = useMemo(
    () => findTable(targetSchemas, targetTable),
    [targetSchemas, targetTable],
  );

  const pkColumns = sourceTableMeta?.primary_key?.columns ?? [];
  const ready =
    sourceProfile &&
    targetProfile &&
    enginesMatch &&
    engineSupported &&
    sourceTableMeta &&
    targetTableMeta &&
    pkColumns.length > 0;

  const runDiff = async () => {
    if (!sourceProfile || !targetProfile || !sourceTableMeta || !targetTableMeta) {
      return;
    }
    if (pkColumns.length === 0) {
      setLoad({
        kind: 'error',
        code: 'no_pk',
        message: 'Source table has no primary key — row alignment needs one.',
      });
      return;
    }
    setLoad({ kind: 'loading' });
    setApplyState({ kind: 'idle' });
    setTab('inserts');
    try {
      const sql = buildOrderedSelect(
        sourceProfile.engine,
        sourceTableMeta,
        pkColumns,
        rowCap,
      );
      const sqlTarget = buildOrderedSelect(
        targetProfile.engine,
        targetTableMeta,
        pkColumns,
        rowCap,
      );
      const [s, t] = await Promise.all([
        api.runQuery(sourceProfile, { sql }),
        api.runQuery(targetProfile, { sql: sqlTarget }),
      ]);
      const diff = diffData(s, t, pkColumns, {
        engine: sourceProfile.engine,
        schemaColumns: sourceTableMeta.columns,
      });
      setLoad({ kind: 'ok', diff });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setLoad({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
  };

  const sync = useMemo(() => {
    if (load.kind !== 'ok' || !sourceProfile || !sourceTableMeta) return null;
    // writeSideVersion is the version of whichever side actually
    // receives the writes. When direction is source→target we're
    // writing to source; when reversed we're writing to target.
    const writeProfile = direction === 'source-to-target' ? sourceProfile : targetProfile;
    const writeVersion = writeProfile
      ? serverInfoBy[writeProfile.id]?.version ?? undefined
      : undefined;
    return buildSyncStatements(
      sourceProfile.engine,
      sourceTableMeta.schema,
      sourceTableMeta.name,
      load.diff,
      { direction, writeSideVersion: writeVersion },
    );
  }, [load, sourceProfile, sourceTableMeta, direction, targetProfile, serverInfoBy]);

  const applySync = async () => {
    if (!sync || !sourceProfile) return;
    const all = [...sync.inserts, ...sync.updates, ...sync.deletes];
    if (all.length === 0) return;
    setApplyState({ kind: 'applying' });
    try {
      for (const stmt of all) {
        await api.runQuery(sourceProfile, { sql: stmt });
      }
      setApplyState({ kind: 'ok' });
      // Re-run the diff so the panels reflect post-sync state.
      await runDiff();
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setApplyState({
        kind: 'error',
        message: err.message ?? err.code ?? 'apply failed',
      });
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Rows3 className="h-5 w-5" />
            Data diff
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick two connections of the same engine. We&apos;ll compare the
            chosen tables row-by-row using the primary key and generate
            INSERT / UPDATE / DELETE statements to bring the source in
            line with the target.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <ConnectionPanel
            label="Source (will be modified)"
            profileId={sourceId}
            onProfileChange={(id) => {
              setSourceId(id);
              setSourceTable('');
              setLoad({ kind: 'idle' });
            }}
            profiles={profiles}
            schema={sourceSchemas}
            tableValue={sourceTable}
            onTableChange={(t) => {
              setSourceTable(t);
              setLoad({ kind: 'idle' });
            }}
          />
          <ConnectionPanel
            label="Target (desired state)"
            profileId={targetId}
            onProfileChange={(id) => {
              setTargetId(id);
              setTargetTable('');
              setLoad({ kind: 'idle' });
            }}
            profiles={profiles}
            schema={targetSchemas}
            tableValue={targetTable}
            onTableChange={(t) => {
              setTargetTable(t);
              setLoad({ kind: 'idle' });
            }}
            // Filter: only show connections with the same engine as
            // source — cross-engine isn't supported in v1.
            engineFilter={sourceProfile?.engine}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Row cap</span>
            <input
              type="number"
              min={100}
              max={1_000_000}
              step={1000}
              value={rowCap}
              onChange={(e) =>
                setRowCap(Math.max(100, Number(e.target.value) || DEFAULT_ROW_CAP))
              }
              className="h-7 w-24 rounded border border-input bg-background px-2 text-xs"
            />
          </label>
          <Button
            size="sm"
            onClick={runDiff}
            disabled={!ready || load.kind === 'loading'}
          >
            {load.kind === 'loading' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            Run diff
          </Button>
          {pkColumns.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              Keyed by{' '}
              <span className="font-mono">{pkColumns.join(', ')}</span>
            </span>
          )}
        </div>

        {sourceProfile && targetProfile && !enginesMatch && (
          <Notice tone="error">
            Engines differ ({ENGINE_LABELS[sourceProfile.engine]} vs{' '}
            {ENGINE_LABELS[targetProfile.engine]}). Data diff is same-engine
            only.
          </Notice>
        )}
        {sourceProfile && !engineSupported && (
          <Notice tone="error">
            {ENGINE_LABELS[sourceProfile.engine]} is non-relational — data
            diff is unavailable for this engine.
          </Notice>
        )}
        {sourceTableMeta && pkColumns.length === 0 && (
          <Notice tone="error">
            <span className="font-mono">
              {sourceTableMeta.schema}.{sourceTableMeta.name}
            </span>{' '}
            has no primary key. Row alignment needs one — pick a different
            table or add a PK first.
          </Notice>
        )}

        {load.kind === 'error' && (
          <Notice tone="error">
            <span className="font-mono">{load.code}</span> · {load.message}
          </Notice>
        )}

        {load.kind === 'ok' && (
          <DiffResults
            diff={load.diff}
            sync={sync}
            tab={tab}
            onTabChange={setTab}
            direction={direction}
            onDirectionChange={setDirection}
            rowCap={rowCap}
            onApply={applySync}
            applyState={applyState}
          />
        )}
      </div>
    </AppShell>
  );
}

// ---------- Sub-components -----------------------------------------------

function ConnectionPanel({
  label,
  profileId,
  onProfileChange,
  profiles,
  schema,
  tableValue,
  onTableChange,
  engineFilter,
}: {
  label: string;
  profileId: string;
  onProfileChange: (id: string) => void;
  profiles: ConnectionProfile[];
  schema: Schema | null;
  tableValue: string;
  onTableChange: (qualified: string) => void;
  engineFilter?: ConnectionProfile['engine'];
}) {
  const connectionOptions: ComboboxOption[] = useMemo(
    () =>
      profiles.map((p) => ({
        value: p.id,
        label: p.name,
        hint: ENGINE_LABELS[p.engine],
        keywords: [p.engine, p.host, p.database].filter(Boolean) as string[],
        // Cross-engine targets stay visible but unpickable so the
        // user can see *why* they can't pick them. The diff is
        // same-engine only — see engineCanDiff.
        disabled: engineFilter ? p.engine !== engineFilter : false,
      })),
    [profiles, engineFilter],
  );

  const tables = schema ? flattenTables(schema) : [];
  const tableOptions: ComboboxOption[] = useMemo(
    () =>
      tables.map((t) => ({
        value: qualify(t),
        label: qualify(t),
        hint: t.primary_key ? undefined : 'no PK',
        // No-PK tables are diff-incompatible (row alignment needs
        // a key). Mark disabled so the user understands why some
        // tables can't be picked.
        disabled: !t.primary_key,
        keywords: [t.schema, t.name],
      })),
    [tables],
  );

  return (
    <div className="space-y-2 rounded border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <Combobox
        value={profileId}
        onChange={onProfileChange}
        options={connectionOptions}
        placeholder="Choose connection…"
        emptyLabel="No connections."
      />
      <Combobox
        value={tableValue}
        onChange={onTableChange}
        options={tableOptions}
        placeholder={
          tables.length === 0 ? 'Pick a connection first' : 'Choose table…'
        }
        emptyLabel={
          tables.length === 0 ? 'Pick a connection first.' : 'No matches.'
        }
        disabled={tables.length === 0}
      />
    </div>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'error' | 'info';
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded border px-3 py-2 text-xs',
        tone === 'error'
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-border bg-muted/40',
      )}
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex-1">{children}</div>
    </div>
  );
}

function DiffResults({
  diff,
  sync,
  tab,
  onTabChange,
  direction,
  onDirectionChange,
  rowCap,
  onApply,
  applyState,
}: {
  diff: DataDiffResult;
  sync: ReturnType<typeof buildSyncStatements> | null;
  tab: ResultTab;
  onTabChange: (next: ResultTab) => void;
  direction: 'source-to-target' | 'target-to-source';
  onDirectionChange: (next: 'source-to-target' | 'target-to-source') => void;
  rowCap: number;
  onApply: () => void;
  applyState:
    | { kind: 'idle' }
    | { kind: 'applying' }
    | { kind: 'ok' }
    | { kind: 'error'; message: string };
}) {
  const inserts = diff.onlyInSource.length;
  const updates = diff.mismatched.length;
  const deletes = diff.onlyInTarget.length;
  const totalSync =
    (sync?.inserts.length ?? 0) +
    (sync?.updates.length ?? 0) +
    (sync?.deletes.length ?? 0);
  const sourceAtCap = diff.sourceCount >= rowCap;
  const targetAtCap = diff.targetCount >= rowCap;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 text-xs">
          <TabButton
            active={tab === 'inserts'}
            onClick={() => onTabChange('inserts')}
          >
            Only in source · {inserts}
          </TabButton>
          <TabButton
            active={tab === 'updates'}
            onClick={() => onTabChange('updates')}
          >
            Mismatched · {updates}
          </TabButton>
          <TabButton
            active={tab === 'deletes'}
            onClick={() => onTabChange('deletes')}
          >
            Only in target · {deletes}
          </TabButton>
          <TabButton active={tab === 'sql'} onClick={() => onTabChange('sql')}>
            Sync SQL · {totalSync}
          </TabButton>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              onDirectionChange(
                direction === 'source-to-target'
                  ? 'target-to-source'
                  : 'source-to-target',
              )
            }
            title="Flip which side gets modified"
          >
            <ArrowRightLeft className="h-3 w-3" />
            {direction === 'source-to-target'
              ? 'Source ← Target'
              : 'Source → Target'}
          </Button>
        </div>
      </div>

      {(sourceAtCap || targetAtCap) && (
        <Notice tone="info">
          Row cap of {rowCap.toLocaleString()} was hit on{' '}
          {sourceAtCap && targetAtCap
            ? 'both sides'
            : sourceAtCap
              ? 'source'
              : 'target'}
          . Diff is partial — raise the cap or narrow the table range first.
        </Notice>
      )}

      {tab === 'inserts' && (
        <RowsTable
          columns={diff.columns}
          rows={diff.onlyInSource.map((r) => r.values)}
          emptyLabel="No rows on source that aren't on target."
          tint="green"
        />
      )}
      {tab === 'deletes' && (
        <RowsTable
          columns={diff.columns}
          rows={diff.onlyInTarget.map((r) => r.values)}
          emptyLabel="No rows on target that aren't on source."
          tint="red"
        />
      )}
      {tab === 'updates' && <MismatchTable diff={diff} />}
      {tab === 'sql' && sync && (
        <SyncSqlPanel
          sync={sync}
          totalSync={totalSync}
          onApply={onApply}
          applyState={applyState}
        />
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded px-2.5 py-1 text-xs',
        active
          ? 'bg-background font-medium text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function RowsTable({
  columns,
  rows,
  emptyLabel,
  tint,
}: {
  columns: string[];
  rows: unknown[][];
  emptyLabel: string;
  tint: 'green' | 'red';
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded border bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="scrollbar-thin max-h-[60vh] overflow-auto rounded border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            {columns.map((c) => (
              <th
                key={c}
                className="border-b px-2 py-1 text-left font-medium text-muted-foreground"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              className={cn(
                'border-b last:border-b-0',
                tint === 'green' && 'bg-emerald-50/60 dark:bg-emerald-950/30',
                tint === 'red' && 'bg-rose-50/60 dark:bg-rose-950/30',
              )}
            >
              {row.map((v, j) => (
                <td
                  key={j}
                  className="border-r px-2 py-0.5 font-mono last:border-r-0"
                >
                  {formatCell(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MismatchTable({ diff }: { diff: DataDiffResult }) {
  if (diff.mismatched.length === 0) {
    return (
      <p className="rounded border bg-muted/40 px-3 py-4 text-center text-xs text-muted-foreground">
        No mismatched rows.
      </p>
    );
  }
  return (
    <div className="scrollbar-thin max-h-[60vh] overflow-auto rounded border">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            <th className="border-b px-2 py-1 text-left font-medium text-muted-foreground">
              Row (PK)
            </th>
            <th className="border-b px-2 py-1 text-left font-medium text-muted-foreground">
              Column
            </th>
            <th className="border-b px-2 py-1 text-left font-medium text-muted-foreground">
              Source
            </th>
            <th className="border-b px-2 py-1 text-left font-medium text-muted-foreground">
              Target
            </th>
          </tr>
        </thead>
        <tbody>
          {diff.mismatched.flatMap((m) =>
            m.changes.map((c, idx) => (
              <tr
                key={`${m.key}-${c.column}`}
                className="border-b last:border-b-0"
              >
                {idx === 0 ? (
                  <td
                    rowSpan={m.changes.length}
                    className="border-r px-2 py-0.5 align-top font-mono"
                  >
                    {m.pkValues.map(formatCell).join(' / ')}
                  </td>
                ) : null}
                <td className="border-r px-2 py-0.5 font-mono">{c.column}</td>
                <td className="border-r bg-rose-50/60 px-2 py-0.5 font-mono dark:bg-rose-950/30">
                  {formatCell(c.source)}
                </td>
                <td className="bg-emerald-50/60 px-2 py-0.5 font-mono dark:bg-emerald-950/30">
                  {formatCell(c.target)}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function SyncSqlPanel({
  sync,
  totalSync,
  onApply,
  applyState,
}: {
  sync: ReturnType<typeof buildSyncStatements>;
  totalSync: number;
  onApply: () => void;
  applyState:
    | { kind: 'idle' }
    | { kind: 'applying' }
    | { kind: 'ok' }
    | { kind: 'error'; message: string };
}) {
  const full = [...sync.inserts, ...sync.updates, ...sync.deletes].join('\n');
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          {sync.inserts.length} insert · {sync.updates.length} update ·{' '}
          {sync.deletes.length} delete. Statements run sequentially against
          the source connection.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={copy} disabled={totalSync === 0}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            Copy
          </Button>
          <Button
            size="sm"
            onClick={onApply}
            disabled={totalSync === 0 || applyState.kind === 'applying'}
          >
            {applyState.kind === 'applying' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Play className="h-3 w-3" />
            )}
            Apply to source
          </Button>
        </div>
      </div>
      {applyState.kind === 'ok' && (
        <Notice tone="info">
          Sync applied — diff re-ran. Any remaining rows above are still
          out of sync (e.g. a literal that the engine rejected).
        </Notice>
      )}
      {applyState.kind === 'error' && (
        <Notice tone="error">Apply failed: {applyState.message}</Notice>
      )}
      <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
        {full || '-- no sync statements needed; tables are aligned.'}
      </pre>
    </div>
  );
}

// ---------- Helpers ------------------------------------------------------

function flattenTables(schema: Schema): Table[] {
  const flat: Table[] = [];
  for (const ns of schema.schemas) for (const t of ns.tables) flat.push(t);
  return flat.sort((a, b) => qualify(a).localeCompare(qualify(b)));
}

function qualify(t: Table): string {
  return t.schema ? `${t.schema}.${t.name}` : t.name;
}

function findTable(schema: Schema | null, qualified: string): Table | null {
  if (!schema || !qualified) return null;
  for (const ns of schema.schemas) {
    for (const t of ns.tables) {
      if (qualify(t) === qualified) return t;
    }
  }
  return null;
}

/** ORDER BY PK ASC + LIMIT N. Stable order isn't strictly required
 *  (we hash by PK on both sides) but keeps row-level diffs stable
 *  between re-runs when the cap kicks in. */
function buildOrderedSelect(
  engine: ConnectionProfile['engine'],
  table: Table,
  pkColumns: string[],
  limit: number,
): string {
  const style = quoteStyleForEngine(engine);
  const q = (n: string) => quoteIdent(n, style);
  const ref =
    engine === 'sqlite' || !table.schema
      ? q(table.name)
      : `${q(table.schema)}.${q(table.name)}`;
  const orderBy = pkColumns.map(q).join(', ');
  return `SELECT * FROM ${ref} ORDER BY ${orderBy} LIMIT ${limit};`;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function DataDiffPage() {
  return (
    <Suspense fallback={null}>
      <DataDiffInner />
    </Suspense>
  );
}
