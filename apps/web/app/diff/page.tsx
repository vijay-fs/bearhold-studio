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
import { AlertCircle, Loader2, GitCompare, Play, Check, Copy } from 'lucide-react';

import { AppShell } from '@/components/AppShell';
import { Button } from '@/components/ui/button';
import { useConnections } from '@/store/connections';
import { useSchemaCache } from '@/store/schemaCache';
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

export default function SchemaDiffPage() {
  const profiles = useConnections((s) => s.profiles);
  const loadSchema = useSchemaCache((s) => s.load);
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
      const [s, t] = await Promise.all([
        loadSchema(sourceProfile),
        loadSchema(targetProfile),
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
    return diffSchemas(load.source, load.target, {
      engine: sourceProfile.engine,
    });
  }, [load, sourceProfile]);

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
  return (
    <label className="block space-y-1">
      <span className="block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm"
      >
        <option value="">— pick a connection —</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({ENGINE_LABELS[p.engine]})
          </option>
        ))}
      </select>
    </label>
  );
}

function DiffList({
  changes,
  sourceProfile,
  onApplied,
}: {
  changes: DiffChange[];
  sourceProfile: ConnectionProfile;
  onApplied: () => void;
}) {
  if (changes.length === 0) {
    return (
      <div className="rounded border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
        Schemas are in sync — no changes needed.
      </div>
    );
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">
          {changes.length} change{changes.length === 1 ? '' : 's'}
        </h2>
        <span className="text-[11px] text-muted-foreground">
          Applies to <span className="font-mono">{sourceProfile.name}</span>
        </span>
      </div>
      <ul className="space-y-3">
        {changes.map((c, i) => (
          <DiffRow
            key={i}
            change={c}
            sourceProfile={sourceProfile}
            onApplied={onApplied}
          />
        ))}
      </ul>
    </section>
  );
}

function DiffRow({
  change,
  sourceProfile,
  onApplied,
}: {
  change: DiffChange;
  sourceProfile: ConnectionProfile;
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

  return (
    <li
      className={cn(
        'rounded border p-3',
        done ? 'border-emerald-500/40 bg-emerald-500/5' : '',
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="font-medium">{change.label}</span>
        <span className="text-muted-foreground">·</span>
        <span className="font-mono text-muted-foreground">{change.kind}</span>
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
