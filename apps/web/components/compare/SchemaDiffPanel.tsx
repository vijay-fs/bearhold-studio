'use client';

// Schema diff panel — the redesigned, low-click flow.
//
// Improvements over the old /diff page:
//   - Auto-compute the moment both connections are picked (with a
//     small debounce so mid-selection state doesn't spam the linter).
//   - Rows are COLLAPSED by default. Users scan the list without
//     drowning in SQL, then expand only what they want to review.
//   - Selection checkboxes + a sticky bottom bar with "Apply N".
//     Applying 12 changes now takes ONE click instead of twelve.
//   - Select-all defaults to every non-destructive change, keeping
//     the "click Apply" flow safe by default while still fast.
//   - Filter chips for each DiffChange kind so you can narrow to
//     "just index changes" before applying.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Play,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSchemaCache } from '@/store/schemaCache';
import { useServerInfoCache } from '@/store/serverInfoCache';
import { useMigrationLog, type MigrationStatement } from '@/store/migrationLog';
import { api } from '@/lib/api';
import { diffSchemas, type DiffChange, type DiffChangeKind } from '@/lib/schemaDiff';
import type { ConnectionProfile } from '@/lib/types';
import type { Schema } from '@dbstudio/erd';
import { cn } from '@/lib/utils';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; source: Schema; target: Schema }
  | { kind: 'error'; code: string; message: string };

type LintOutcome =
  | { kind: 'ok' }
  | { kind: 'fail'; error: string }
  | { kind: 'unverifiable'; reason: string };

type LintState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'ok'; byIndex: Map<number, LintOutcome> }
  | { kind: 'error'; message: string };

const DESTRUCTIVE_KINDS: DiffChangeKind[] = ['drop-table', 'drop-column', 'drop-index'];

interface Props {
  source: ConnectionProfile | undefined;
  target: ConnectionProfile | undefined;
}

export function SchemaDiffPanel({ source, target }: Props) {
  const loadSchema = useSchemaCache((s) => s.load);
  const loadServerInfo = useServerInfoCache((s) => s.load);
  const serverInfoBy = useServerInfoCache((s) => s.entries);

  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [lint, setLint] = useState<LintState>({ kind: 'idle' });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editedSql, setEditedSql] = useState<Map<number, string>>(new Map());
  const [kindFilter, setKindFilter] = useState<DiffChangeKind | 'all'>('all');
  const [applying, setApplying] = useState(false);
  const [appliedIds, setAppliedIds] = useState<Set<number>>(new Set());
  const [applyErrors, setApplyErrors] = useState<Map<number, string>>(new Map());

  // Auto-compute the diff when both sides are present. Debounced by
  // one tick so switching source doesn't fire a doomed request
  // against a stale target.
  useEffect(() => {
    if (!source || !target || source.id === target.id) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setLoad({ kind: 'loading' });
      try {
        const [s, t] = await Promise.all([
          loadSchema(source),
          loadSchema(target),
          loadServerInfo(source),
          loadServerInfo(target),
        ]);
        if (cancelled) return;
        setLoad({ kind: 'ok', source: s, target: t });
      } catch (e: unknown) {
        if (cancelled) return;
        const err = e as { code?: string; message?: string };
        setLoad({
          kind: 'error',
          code: err.code ?? 'unknown',
          message: err.message ?? String(e),
        });
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [source?.id, target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const changes = useMemo(() => {
    if (load.kind !== 'ok' || !source) return [];
    const info = serverInfoBy[source.id];
    return diffSchemas(load.source, load.target, {
      engine: source.engine,
      sourceVersion: info?.version ?? undefined,
    });
  }, [load, source, serverInfoBy]);

  // Recompute the safe-default selection whenever the change set
  // shifts: everything EXCEPT destructive kinds is pre-selected.
  useEffect(() => {
    setSelected(() => {
      const next = new Set<number>();
      changes.forEach((c, i) => {
        if (!DESTRUCTIVE_KINDS.includes(c.kind)) next.add(i);
      });
      return next;
    });
    setExpanded(new Set());
    setEditedSql(new Map());
    setAppliedIds(new Set());
    setApplyErrors(new Map());
  }, [changes]);

  // Kick the dry-run linter whenever the change set changes.
  useEffect(() => {
    if (!source || changes.length === 0) {
      setLint({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLint({ kind: 'running' });
    void api
      .dryRunStatements(source, changes.map((c) => c.sql))
      .then((results) => {
        if (cancelled) return;
        const byIndex = new Map<number, LintOutcome>();
        for (const r of results) byIndex.set(r.index, r.outcome);
        setLint({ kind: 'ok', byIndex });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const err = e as { code?: string; message?: string };
        setLint({
          kind: 'error',
          message: `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [changes, source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const kindsInList = useMemo(() => {
    const set = new Set<DiffChangeKind>();
    for (const c of changes) set.add(c.kind);
    return set;
  }, [changes]);

  const filtered = useMemo(() => {
    if (kindFilter === 'all') return changes.map((c, i) => ({ change: c, index: i }));
    return changes
      .map((c, i) => ({ change: c, index: i }))
      .filter((r) => r.change.kind === kindFilter);
  }, [changes, kindFilter]);

  const selectedCount = selected.size;
  const failingSelected = useMemo(() => {
    if (lint.kind !== 'ok') return 0;
    let n = 0;
    for (const i of selected) if (lint.byIndex.get(i)?.kind === 'fail') n++;
    return n;
  }, [selected, lint]);

  const recordMigration = useMigrationLog((s) => s.record);

  const applySelected = async () => {
    if (!source || selectedCount === 0) return;
    setApplying(true);
    const applied = new Set<number>(appliedIds);
    const errors = new Map<number, string>();

    // `changes` is already dependency-sorted by diffSchemas — creates
    // before alters before drops, and inside each phase, parents
    // before children (drops reversed). Selecting a subset preserves
    // that order; iterating by index respects it.
    const orderedIndices = [...selected].sort((a, b) => a - b);
    const statements = orderedIndices.map(
      (idx) => editedSql.get(idx) ?? changes[idx]!.sql,
    );

    let batch: Awaited<ReturnType<typeof api.applyBatch>>;
    try {
      batch = await api.applyBatch(source, statements);
    } catch (e: unknown) {
      // Command failure (network/serde/etc) — record as a failed
      // migration and surface a summary error on the first row.
      const err = e as { code?: string; message?: string };
      const message = `${err.code ?? 'unknown'} · ${err.message ?? String(e)}`;
      const first = orderedIndices[0];
      if (first != null) errors.set(first, message);
      setApplyErrors(errors);
      setAppliedIds(applied);
      setApplying(false);
      recordMigration({
        kind: 'schema',
        sourceConnectionId: source.id,
        sourceConnectionName: source.name,
        targetConnectionId: target?.id ?? null,
        targetConnectionName: target?.name ?? null,
        engine: source.engine,
        committed: false,
        summary: `apply_batch call failed: ${message}`,
        label: 'Schema diff',
        statements: statements.map((sql) => ({
          sql,
          outcome: { kind: 'fail', error: message },
        })),
      });
      return;
    }

    // Batch returned — build the applied / errors maps from the
    // per-statement outcomes. Ok statements land in `applied`;
    // Fail / Skipped surface in the errors map so the row shows
    // the reason inline.
    const migrationStatements: MigrationStatement[] = [];
    batch.statements.forEach((s, i) => {
      const originalIdx = orderedIndices[i]!;
      const sql = statements[i]!;
      if (s.outcome.kind === 'ok') {
        applied.add(originalIdx);
        migrationStatements.push({
          sql,
          outcome: { kind: 'ok', rowsAffected: s.outcome.rows_affected ?? null },
        });
      } else if (s.outcome.kind === 'fail') {
        errors.set(originalIdx, s.outcome.error);
        migrationStatements.push({
          sql,
          outcome: { kind: 'fail', error: s.outcome.error },
        });
      } else {
        errors.set(originalIdx, 'Skipped — earlier statement failed');
        migrationStatements.push({ sql, outcome: { kind: 'skipped' } });
      }
    });

    setAppliedIds(applied);
    setApplyErrors(errors);
    setApplying(false);

    recordMigration({
      kind: 'schema',
      sourceConnectionId: source.id,
      sourceConnectionName: source.name,
      targetConnectionId: target?.id ?? null,
      targetConnectionName: target?.name ?? null,
      engine: source.engine,
      committed: batch.committed,
      summary: batch.summary,
      label: 'Schema diff',
      statements: migrationStatements,
    });

    // Refresh source schema so the diff list reflects the new state.
    void loadSchema(source, true).catch(() => {});
  };

  const copySelected = async () => {
    const parts: string[] = [];
    for (const idx of [...selected].sort((a, b) => a - b)) {
      const sql = editedSql.get(idx) ?? changes[idx]?.sql;
      if (sql) parts.push(sql);
    }
    if (parts.length === 0) return;
    await navigator.clipboard.writeText(parts.join('\n\n')).catch(() => {});
  };

  if (!source || !target) {
    return (
      <EmptyMessage>Pick a source and target connection to compare.</EmptyMessage>
    );
  }
  if (source.id === target.id) return null;

  if (load.kind === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading schemas + version info…
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span className="font-semibold">Couldn&apos;t load schemas</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-mono">{load.code}</span> · {load.message}
        </p>
      </div>
    );
  }
  if (load.kind !== 'ok') return null;

  if (changes.length === 0) {
    return (
      <EmptyMessage>
        <span className="inline-flex items-center gap-1.5">
          <Check className="h-3.5 w-3.5 text-emerald-600" />
          Schemas are in sync.
        </span>
      </EmptyMessage>
    );
  }

  return (
    <div className="space-y-3">
      {/* Filter chips — one per kind present in the current diff. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          label="All"
          count={changes.length}
          active={kindFilter === 'all'}
          onClick={() => setKindFilter('all')}
        />
        {[...kindsInList].sort().map((k) => (
          <FilterChip
            key={k}
            label={humanKind(k)}
            count={changes.filter((c) => c.kind === k).length}
            active={kindFilter === k}
            onClick={() => setKindFilter(k)}
          />
        ))}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          <LintSummary lint={lint} />
        </div>
      </div>

      {/* Header row with select-all + expand-all. */}
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          className="cursor-pointer"
          checked={
            filtered.length > 0 && filtered.every((r) => selected.has(r.index))
          }
          onChange={(e) => {
            const next = new Set(selected);
            for (const r of filtered) {
              if (e.target.checked) next.add(r.index);
              else next.delete(r.index);
            }
            setSelected(next);
          }}
        />
        <span>
          {selectedCount} of {changes.length} selected
        </span>
        <button
          type="button"
          onClick={() => {
            if (expanded.size === filtered.length) setExpanded(new Set());
            else setExpanded(new Set(filtered.map((r) => r.index)));
          }}
          className="ml-auto text-xs hover:text-foreground"
        >
          {expanded.size === filtered.length ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      <ul className="space-y-1">
        {filtered.map(({ change, index }) => (
          <DiffRow
            key={index}
            change={change}
            index={index}
            selected={selected.has(index)}
            expanded={expanded.has(index)}
            editedSql={editedSql.get(index)}
            lintOutcome={lint.kind === 'ok' ? lint.byIndex.get(index) : undefined}
            lintRunning={lint.kind === 'running'}
            applied={appliedIds.has(index)}
            applyError={applyErrors.get(index) ?? null}
            onToggleSelect={() => {
              const next = new Set(selected);
              if (next.has(index)) next.delete(index);
              else next.add(index);
              setSelected(next);
            }}
            onToggleExpand={() => {
              const next = new Set(expanded);
              if (next.has(index)) next.delete(index);
              else next.add(index);
              setExpanded(next);
            }}
            onEditSql={(sql) => {
              const next = new Map(editedSql);
              next.set(index, sql);
              setEditedSql(next);
            }}
          />
        ))}
      </ul>

      <StickyActionBar
        selectedCount={selectedCount}
        failingSelected={failingSelected}
        applying={applying}
        onApply={applySelected}
        onCopy={copySelected}
      />
    </div>
  );
}

// --- Sub-components -------------------------------------------------

function DiffRow({
  change,
  index,
  selected,
  expanded,
  editedSql,
  lintOutcome,
  lintRunning,
  applied,
  applyError,
  onToggleSelect,
  onToggleExpand,
  onEditSql,
}: {
  change: DiffChange;
  index: number;
  selected: boolean;
  expanded: boolean;
  editedSql: string | undefined;
  lintOutcome: LintOutcome | undefined;
  lintRunning: boolean;
  applied: boolean;
  applyError: string | null;
  onToggleSelect: () => void;
  onToggleExpand: () => void;
  onEditSql: (sql: string) => void;
}) {
  const destructive = DESTRUCTIVE_KINDS.includes(change.kind);
  const sql = editedSql ?? change.sql;
  const lintFailed = lintOutcome?.kind === 'fail';
  return (
    <li
      className={cn(
        'rounded-lg border transition',
        applied && 'border-emerald-500/40 bg-emerald-500/5',
        !applied && applyError && 'border-destructive/50 bg-destructive/5',
        !applied && !applyError && lintFailed && 'border-destructive/50 bg-destructive/5',
        !applied && !applyError && !lintFailed && 'bg-card',
      )}
    >
      <div className="flex items-center gap-3 px-3 py-2 text-xs">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          disabled={applied}
          className="cursor-pointer disabled:opacity-40"
          aria-label={`select ${change.label}`}
        />
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 text-muted-foreground transition',
              expanded && 'rotate-90',
            )}
          />
          <span className="font-medium">{change.label}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
              destructive
                ? 'bg-destructive/10 text-destructive'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {change.kind}
          </span>
        </button>
        <LintBadge outcome={lintOutcome} running={lintRunning} applied={applied} />
      </div>

      {expanded && (
        <div className="border-t px-3 py-2">
          <textarea
            value={sql}
            onChange={(e) => onEditSql(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            rows={Math.min(8, sql.split('\n').length + 1)}
            className="scrollbar-thin w-full resize-y rounded border border-input bg-background p-2 font-mono text-[11px]"
            disabled={applied}
          />
          {lintOutcome?.kind === 'fail' && !applied && (
            <p className="mt-1.5 text-xs text-destructive">
              <span className="font-semibold">Server would reject:</span>{' '}
              <span className="font-mono">{lintOutcome.error}</span>
            </p>
          )}
          {lintOutcome?.kind === 'unverifiable' && !applied && (
            <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
              {lintOutcome.reason}
            </p>
          )}
          {applyError && (
            <p className="mt-1.5 text-xs text-destructive">
              <span className="font-semibold">Apply failed:</span> {applyError}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function StickyActionBar({
  selectedCount,
  failingSelected,
  applying,
  onApply,
  onCopy,
}: {
  selectedCount: number;
  failingSelected: number;
  applying: boolean;
  onApply: () => void;
  onCopy: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="sticky bottom-4 z-20 flex items-center gap-3 rounded-xl border bg-card/95 p-3 shadow-lg backdrop-blur">
      <div className="flex-1 text-sm">
        <span className="font-medium">{selectedCount}</span>{' '}
        <span className="text-muted-foreground">selected</span>
        {failingSelected > 0 && (
          <span className="ml-2 text-xs text-destructive">
            · {failingSelected} would fail lint
          </span>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onCopy}>
        <Copy className="h-3.5 w-3.5" />
        Copy
      </Button>
      <Button
        size="sm"
        onClick={onApply}
        disabled={applying}
        className={cn(failingSelected > 0 && 'bg-destructive hover:bg-destructive/90')}
      >
        {applying ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        Apply {selectedCount}
      </Button>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] transition',
        active
          ? 'border-primary bg-primary/10 font-medium text-primary'
          : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground',
      )}
    >
      {label}
      <span
        className={cn(
          'rounded-full px-1 font-mono text-[10px]',
          active ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function LintBadge({
  outcome,
  running,
  applied,
}: {
  outcome: LintOutcome | undefined;
  running: boolean;
  applied: boolean;
}) {
  if (applied) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
        <Check className="h-2.5 w-2.5" />
        Applied
      </span>
    );
  }
  if (running || !outcome) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Checking
      </span>
    );
  }
  if (outcome.kind === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="h-2.5 w-2.5" />
        Verified
      </span>
    );
  }
  if (outcome.kind === 'fail') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
        <ShieldAlert className="h-2.5 w-2.5" />
        Would fail
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
      <ShieldQuestion className="h-2.5 w-2.5" />
      Unverified
    </span>
  );
}

function LintSummary({ lint }: { lint: LintState }) {
  if (lint.kind === 'running') {
    return (
      <span className="inline-flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Verifying…
      </span>
    );
  }
  if (lint.kind === 'ok') {
    let ok = 0;
    let fail = 0;
    let unv = 0;
    for (const o of lint.byIndex.values()) {
      if (o.kind === 'ok') ok++;
      else if (o.kind === 'fail') fail++;
      else unv++;
    }
    return (
      <>
        <span className="text-emerald-600">{ok} verified</span>
        {fail > 0 && <span className="text-destructive">· {fail} failing</span>}
        {unv > 0 && (
          <span className="text-amber-600 dark:text-amber-400">· {unv} unverified</span>
        )}
      </>
    );
  }
  return null;
}

function humanKind(k: DiffChangeKind): string {
  return k
    .split('-')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}

function EmptyMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
