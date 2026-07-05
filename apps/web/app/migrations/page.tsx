'use client';

// Migration history — every apply from the Compare workspace lands
// here with a per-statement outcome and enough metadata to review
// what happened. The entries are the raw material for a future
// revert flow.

import { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Clock,
  Copy,
  Database,
  Filter,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { useMigrationLog, type MigrationEntry } from '@/store/migrationLog';
import { ENGINE_LABELS } from '@/lib/types';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'committed' | 'failed';

export default function MigrationsPage() {
  const entries = useMigrationLog((s) => s.entries);
  const remove = useMigrationLog((s) => s.remove);
  const clear = useMigrationLog((s) => s.clear);
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((e) =>
      filter === 'committed' ? e.committed : !e.committed,
    );
  }, [entries, filter]);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl space-y-5 p-6">
        <header className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Migrations</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Every batch apply from the Compare workspace, per-statement.
              Kept locally on this device.
            </p>
          </div>
          {entries.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => clear()}>
              <Trash2 className="h-3.5 w-3.5" />
              Clear history
            </Button>
          )}
        </header>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-card px-6 py-14 text-center text-sm text-muted-foreground">
            No migrations recorded yet. Run a schema or data diff Apply and
            it&apos;ll show up here.
          </div>
        ) : (
          <>
            <FilterBar filter={filter} onFilterChange={setFilter} entries={entries} />
            <ul className="space-y-3">
              {filtered.map((e) => (
                <MigrationRow key={e.id} entry={e} onRemove={() => remove(e.id)} />
              ))}
            </ul>
          </>
        )}
      </div>
    </AppShell>
  );
}

function FilterBar({
  filter,
  onFilterChange,
  entries,
}: {
  filter: Filter;
  onFilterChange: (f: Filter) => void;
  entries: MigrationEntry[];
}) {
  const committed = entries.filter((e) => e.committed).length;
  const failed = entries.length - committed;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Chip
        label="All"
        count={entries.length}
        active={filter === 'all'}
        onClick={() => onFilterChange('all')}
      />
      <Chip
        label="Committed"
        count={committed}
        active={filter === 'committed'}
        onClick={() => onFilterChange('committed')}
      />
      <Chip
        label="Failed / partial"
        count={failed}
        active={filter === 'failed'}
        onClick={() => onFilterChange('failed')}
      />
      <div className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
        <Filter className="h-3 w-3" />
        {entries.length} recorded
      </div>
    </div>
  );
}

function Chip({
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
      <span className="rounded-full bg-muted px-1 font-mono text-[10px]">
        {count}
      </span>
    </button>
  );
}

function MigrationRow({
  entry,
  onRemove,
}: {
  entry: MigrationEntry;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const okCount = entry.statements.filter((s) => s.outcome.kind === 'ok').length;
  const failCount = entry.statements.filter(
    (s) => s.outcome.kind === 'fail',
  ).length;
  const skippedCount = entry.statements.filter(
    (s) => s.outcome.kind === 'skipped',
  ).length;

  const copySql = async () => {
    const text = entry.statements.map((s) => s.sql).join('\n\n');
    await navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <li
      className={cn(
        'rounded-xl border bg-card p-4 shadow-sm',
        entry.committed ? 'border-border' : 'border-destructive/40',
      )}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition',
              expanded && 'rotate-90',
            )}
          />
          <span className="font-medium">{entry.label}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {entry.kind === 'schema' ? 'Schema' : 'Data'}
          </span>
        </button>
        <StatusBadge committed={entry.committed} />
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Remove from history"
          title="Remove"
        >
          <XCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Database className="h-3 w-3" />
          {entry.sourceConnectionName} · {ENGINE_LABELS[entry.engine]}
        </span>
        {entry.targetConnectionName && (
          <span>vs {entry.targetConnectionName}</span>
        )}
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {new Date(entry.timestamp).toLocaleString()}
        </span>
        <span>·</span>
        <span>
          <span className="text-emerald-600">{okCount} ok</span>
          {failCount > 0 && (
            <span className="text-destructive"> · {failCount} failed</span>
          )}
          {skippedCount > 0 && (
            <span className="text-muted-foreground/80"> · {skippedCount} skipped</span>
          )}
        </span>
      </div>

      {!entry.committed && (
        <p className="mt-2 rounded bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {entry.summary}
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-1.5 rounded-lg border bg-muted/20 p-2 text-[11px]">
          <div className="flex items-center justify-end gap-2 px-1 pb-1">
            <Button variant="outline" size="sm" onClick={copySql}>
              <Copy className="h-3 w-3" />
              Copy SQL
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Revert coming soon — needs inverse SQL generation"
            >
              <RotateCcw className="h-3 w-3" />
              Revert
            </Button>
          </div>
          {entry.statements.map((s, i) => (
            <div
              key={i}
              className={cn(
                'flex items-start gap-2 rounded px-2 py-1',
                s.outcome.kind === 'fail' && 'bg-destructive/5',
                s.outcome.kind === 'skipped' && 'bg-muted/40',
              )}
            >
              <StatementIcon outcome={s.outcome} />
              <div className="min-w-0 flex-1">
                <code className="block truncate font-mono">{s.sql}</code>
                {s.outcome.kind === 'fail' && (
                  <p className="mt-0.5 text-destructive">{s.outcome.error}</p>
                )}
                {s.outcome.kind === 'ok' && s.outcome.rowsAffected != null && (
                  <p className="mt-0.5 text-muted-foreground">
                    {s.outcome.rowsAffected} row
                    {s.outcome.rowsAffected === 1 ? '' : 's'} affected
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function StatusBadge({ committed }: { committed: boolean }) {
  if (committed) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
        <Check className="h-2.5 w-2.5" />
        Committed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
      <AlertCircle className="h-2.5 w-2.5" />
      Rolled back
    </span>
  );
}

function StatementIcon({
  outcome,
}: {
  outcome: MigrationEntry['statements'][number]['outcome'];
}) {
  if (outcome.kind === 'ok') {
    return <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />;
  }
  if (outcome.kind === 'fail') {
    return <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />;
  }
  return (
    <span
      className="mt-1 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
      aria-label="skipped"
    />
  );
}
