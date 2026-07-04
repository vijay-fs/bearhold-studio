'use client';

// Schema-diff workspace. Pick two connections — "source" (the one we
// modify) and "target" (the one we want source to look like) — load
// both schemas, compute the diff, and let the user review/apply each
// generated statement individually.
//
// Convention: changes are made TO the source. The label "target"
// matches what most database tools call the desired-state side. The
// generated SQL always runs against the source connection.

import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  GitCompare,
  Play,
  Check,
  Copy,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
} from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
import { useServerInfoCache } from '@/store/serverInfoCache';
import { api } from '@/lib/api';
import { ENGINE_LABELS, type ConnectionProfile } from '@/lib/types';
import type { Schema } from '@dbstudio/erd';
import { cn } from '@/lib/utils';
import { diffSchemas, type DiffChange } from '@/lib/schemaDiff';

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

export default function SchemaDiffPage() {
  const profiles = useConnections((s) => s.profiles);
  const loadSchema = useSchemaCache((s) => s.load);
  const loadServerInfo = useServerInfoCache((s) => s.load);
  const serverInfoBy = useServerInfoCache((s) => s.entries);
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });

  const sourceProfile = profiles.find((p) => p.id === sourceId);
  const targetProfile = profiles.find((p) => p.id === targetId);
  const sameProfile = sourceId && sourceId === targetId;
  const enginesMismatch =
    sourceProfile &&
    targetProfile &&
    sourceProfile.engine !== targetProfile.engine;

  const runDiff = async () => {
    if (!sourceProfile || !targetProfile) return;
    setLoad({ kind: 'loading' });
    try {
      // Fetch schemas + server info in parallel. Server info drives
      // the version-aware DDL emission — without it we fall back to
      // safe-minimum syntax which loses IF NOT EXISTS, RETURNING, etc.
      const [s, t] = await Promise.all([
        loadSchema(sourceProfile),
        loadSchema(targetProfile),
        loadServerInfo(sourceProfile),
        loadServerInfo(targetProfile),
      ]);
      setLoad({ kind: 'ok', source: s, target: t });
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setLoad({
        kind: 'error',
        code: err.code ?? 'unknown',
        message: err.message ?? String(e),
      });
    }
  };

  const changes = useMemo(() => {
    if (load.kind !== 'ok' || !sourceProfile) return [];
    // Emit SQL for the SOURCE server version — that's the side the
    // diff runs against. Target version is informational; it drove
    // the introspection but doesn't affect emitted syntax.
    const srcInfo = serverInfoBy[sourceProfile.id];
    return diffSchemas(load.source, load.target, {
      engine: sourceProfile.engine,
      sourceVersion: srcInfo?.version ?? undefined,
    });
  }, [load, sourceProfile, serverInfoBy]);

  // Fire the dry-run linter whenever the change set changes. Runs
  // against the SOURCE server (the apply target). The linter uses
  // savepoints (PG/SQLite) or PREPARE/EXPLAIN (MySQL) so
  // schema state is never mutated. Result is a per-index map the
  // DiffRow reads to badge itself green/red/yellow.
  const [lint, setLint] = useState<LintState>({ kind: 'idle' });
  useEffect(() => {
    if (!sourceProfile || changes.length === 0) {
      setLint({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLint({ kind: 'running' });
    void api
      .dryRunStatements(sourceProfile, changes.map((c) => c.sql))
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
  }, [changes, sourceProfile]);

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <GitCompare className="h-5 w-5" />
            Schema diff
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick two connections. We&apos;ll generate ALTER statements to
            bring the source in line with the target. Each statement is
            editable and runs only when you click Apply.
          </p>
        </header>

        <div className="grid gap-3 sm:grid-cols-2">
          <ConnectionPicker
            label="Source (will be modified)"
            value={sourceId}
            onChange={setSourceId}
            profiles={profiles}
          />
          <ConnectionPicker
            label="Target (desired state)"
            value={targetId}
            onChange={setTargetId}
            profiles={profiles}
          />
        </div>

        {sameProfile && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Source and target are the same connection — the diff will be empty.
          </p>
        )}
        {enginesMismatch && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Engines differ ({ENGINE_LABELS[sourceProfile.engine]} vs{' '}
            {ENGINE_LABELS[targetProfile.engine]}). Generated SQL uses the
            source engine&apos;s dialect — verify before applying.
          </p>
        )}

        <Button
          onClick={runDiff}
          disabled={
            !sourceProfile ||
            !targetProfile ||
            sameProfile === true ||
            load.kind === 'loading'
          }
        >
          {load.kind === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <GitCompare className="h-3.5 w-3.5" />
          )}
          Compute diff
        </Button>

        {load.kind === 'error' && (
          <div className="rounded border border-destructive/30 bg-destructive/5 p-3">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm font-semibold">Couldn&apos;t load schemas</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">{load.code}</span> · {load.message}
            </p>
          </div>
        )}

        {load.kind === 'ok' && sourceProfile && (
          <DiffList
            changes={changes}
            sourceProfile={sourceProfile}
            lint={lint}
            onApplied={() => {
              // After at least one statement applied, the source's
              // cached schema is stale. Force a reload so the diff
              // list is recomputed against fresh state.
              void runDiff();
            }}
          />
        )}
      </div>
    </AppShell>
  );
}

function ConnectionPicker({
  label,
  value,
  onChange,
  profiles,
}: {
  label: string;
  value: string;
  onChange: (id: string) => void;
  profiles: ConnectionProfile[];
}) {
  const options: ComboboxOption[] = profiles.map((p) => ({
    value: p.id,
    label: p.name,
    hint: ENGINE_LABELS[p.engine],
    keywords: [p.engine, p.host, p.database].filter(Boolean) as string[],
  }));
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Combobox
        value={value}
        onChange={onChange}
        options={options}
        placeholder="— pick a connection —"
        emptyLabel="No connections."
      />
    </label>
  );
}

function DiffList({
  changes,
  sourceProfile,
  lint,
  onApplied,
}: {
  changes: DiffChange[];
  sourceProfile: ConnectionProfile;
  lint: LintState;
  onApplied: () => void;
}) {
  if (changes.length === 0) {
    return (
      <div className="rounded border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
        Schemas are in sync — no changes needed.
      </div>
    );
  }
  const failing =
    lint.kind === 'ok'
      ? Array.from(lint.byIndex.values()).filter((o) => o.kind === 'fail').length
      : 0;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {changes.length} change{changes.length === 1 ? '' : 's'}
        </h2>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <LintSummary lint={lint} failing={failing} />
          <span>
            Applies to <span className="font-mono">{sourceProfile.name}</span>
          </span>
        </div>
      </div>
      <ul className="space-y-3">
        {changes.map((c, i) => (
          <DiffRow
            key={i}
            change={c}
            sourceProfile={sourceProfile}
            lintOutcome={lint.kind === 'ok' ? lint.byIndex.get(i) : undefined}
            lintRunning={lint.kind === 'running'}
            onApplied={onApplied}
          />
        ))}
      </ul>
    </section>
  );
}

function LintSummary({ lint, failing }: { lint: LintState; failing: number }) {
  if (lint.kind === 'running') {
    return (
      <span className="flex items-center gap-1">
        <Loader2 className="h-3 w-3 animate-spin" />
        Dry-running…
      </span>
    );
  }
  if (lint.kind === 'error') {
    return (
      <span className="text-amber-600 dark:text-amber-400">
        Dry-run unavailable: {lint.message}
      </span>
    );
  }
  if (lint.kind === 'ok') {
    if (failing === 0) return <span className="text-emerald-600">All statements dry-run cleanly.</span>;
    return (
      <span className="text-destructive">
        {failing} statement{failing === 1 ? '' : 's'} failed dry-run.
      </span>
    );
  }
  return null;
}

function DiffRow({
  change,
  sourceProfile,
  lintOutcome,
  lintRunning,
  onApplied,
}: {
  change: DiffChange;
  sourceProfile: ConnectionProfile;
  lintOutcome: LintOutcome | undefined;
  lintRunning: boolean;
  onApplied: () => void;
}) {
  const [sql, setSql] = useState(change.sql);
  // Reset the editable SQL when the row's underlying change reference
  // changes (e.g. after re-running diff post-apply).
  useEffect(() => setSql(change.sql), [change.sql]);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    setError(null);
    setApplying(true);
    try {
      await api.runQuery(sourceProfile, { sql });
      setDone(true);
      onApplied();
    } catch (e: unknown) {
      const err = e as { code?: string; message?: string };
      setError(`${err.code ?? 'unknown'} · ${err.message ?? String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  const destructive = change.kind === 'drop-table' || change.kind === 'drop-column';
  const lintFailed = lintOutcome?.kind === 'fail';

  return (
    <li
      className={cn(
        'rounded border p-3',
        done && 'border-emerald-500/40 bg-emerald-500/5',
        !done && lintFailed && 'border-destructive/50 bg-destructive/5',
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="font-medium">{change.label}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground">{change.kind}</span>
        <LintBadge outcome={lintOutcome} running={lintRunning} />
      </div>
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        rows={Math.min(8, sql.split('\n').length + 1)}
        className="scrollbar-thin w-full resize-y rounded border border-input bg-background p-2 font-mono text-[11px]"
        disabled={applying || done}
      />
      {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      {lintOutcome?.kind === 'fail' && !done && (
        <p className="mt-1.5 text-xs text-destructive">
          <span className="font-semibold">Server would reject this:</span>{' '}
          <span className="font-mono">{lintOutcome.error}</span>
        </p>
      )}
      {lintOutcome?.kind === 'unverifiable' && !done && (
        <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
          {lintOutcome.reason}
        </p>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void navigator.clipboard.writeText(sql)}
          disabled={applying}
        >
          <Copy className="h-3 w-3" />
          Copy
        </Button>
        <Button
          size="sm"
          variant={destructive ? 'destructive' : 'default'}
          onClick={apply}
          disabled={applying || done || !sql.trim()}
        >
          {done ? (
            <Check className="h-3 w-3" />
          ) : applying ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          {done ? 'Applied' : 'Apply'}
        </Button>
      </div>
    </li>
  );
}

function LintBadge({
  outcome,
  running,
}: {
  outcome: LintOutcome | undefined;
  running: boolean;
}) {
  if (running || !outcome) {
    return (
      <span className="ml-auto inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
        Verifying…
      </span>
    );
  }
  if (outcome.kind === 'ok') {
    return (
      <span className="ml-auto inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
        <ShieldCheck className="h-2.5 w-2.5" />
        Verified
      </span>
    );
  }
  if (outcome.kind === 'fail') {
    return (
      <span className="ml-auto inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
        <ShieldAlert className="h-2.5 w-2.5" />
        Would fail
      </span>
    );
  }
  return (
    <span className="ml-auto inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
      <ShieldQuestion className="h-2.5 w-2.5" />
      Unverified
    </span>
  );
}
